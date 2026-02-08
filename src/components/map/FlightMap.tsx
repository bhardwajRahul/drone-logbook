/**
 * Flight map component using react-map-gl with MapLibre
 * Displays the GPS track of the selected flight
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import Map, { NavigationControl, Marker } from 'react-map-gl/maplibre';
import type { MapRef } from 'react-map-gl/maplibre';
import type { StyleSpecification } from 'maplibre-gl';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import DeckGL from '@deck.gl/react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { getTrackCenter, calculateBounds, formatAltitude, formatSpeed, formatDistance } from '@/lib/utils';
import { useFlightStore } from '@/stores/flightStore';

interface FlightMapProps {
  track: [number, number, number][]; // [lng, lat, alt][]
  homeLat?: number | null;
  homeLon?: number | null;
  durationSecs?: number | null;
  themeMode: 'system' | 'dark' | 'light';
}

type ColorByMode = 'progress' | 'height' | 'speed' | 'distance';

const MAP_STYLES = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
} as const;

const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: [
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 18,
      attribution: 'Tiles © Esri',
    },
  },
  layers: [
    {
      id: 'satellite-base',
      type: 'raster',
      source: 'satellite',
      paint: {
        'raster-fade-duration': 150,
      },
    },
  ],
};

const TERRAIN_SOURCE_ID = 'terrain-dem';
const TERRAIN_SOURCE = {
  type: 'raster-dem',
  url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json',
  tileSize: 256,
  maxzoom: 12,
} as const;

const getSessionBool = (key: string, fallback: boolean) => {
  if (typeof window === 'undefined') return fallback;
  const stored = window.sessionStorage.getItem(key);
  if (stored === null) return fallback;
  return stored === 'true';
};

// ─── Catmull-Rom spline smoothing ───────────────────────────────────────────
// Interpolates between GPS points to produce a smooth, natural curve.
// `resolution` controls how many sub-points to insert between each pair (higher = smoother).
function smoothTrack(
  points: [number, number, number][],
  resolution = 4
): [number, number, number][] {
  if (points.length < 3) return points;

  const result: [number, number, number][] = [];
  const n = points.length;

  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, n - 1)];

    for (let step = 0; step < resolution; step++) {
      const t = step / resolution;
      const t2 = t * t;
      const t3 = t2 * t;

      // Catmull-Rom coefficients
      const lng =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const lat =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      const alt =
        0.5 *
        (2 * p1[2] +
          (-p0[2] + p2[2]) * t +
          (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 +
          (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3);

      result.push([lng, lat, alt]);
    }
  }

  // Always include the final point
  result.push(points[n - 1]);
  return result;
}

// ─── Haversine distance in meters ───────────────────────────────────────────
function haversineM(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Color ramps ────────────────────────────────────────────────────────────
// Maps a normalized value 0→1 to a color via multi-stop gradient.
function valueToColor(
  t: number,
  ramp: [number, number, number][]
): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const maxIdx = ramp.length - 1;
  const scaled = clamped * maxIdx;
  const lo = Math.floor(scaled);
  const hi = Math.min(lo + 1, maxIdx);
  const f = scaled - lo;
  return [
    Math.round(ramp[lo][0] + (ramp[hi][0] - ramp[lo][0]) * f),
    Math.round(ramp[lo][1] + (ramp[hi][1] - ramp[lo][1]) * f),
    Math.round(ramp[lo][2] + (ramp[hi][2] - ramp[lo][2]) * f),
  ];
}

// Yellow → Red  (start→end progress)
const RAMP_PROGRESS: [number, number, number][] = [
  [250, 204, 21],
  [239, 68, 68],
];
// Green → Yellow → Red  (low→high value)
const RAMP_HEIGHT: [number, number, number][] = [
  [34, 197, 94],
  [250, 204, 21],
  [239, 68, 68],
];
// Blue → Cyan → Green → Yellow → Red  (speed)
const RAMP_SPEED: [number, number, number][] = [
  [59, 130, 246],
  [34, 211, 238],
  [34, 197, 94],
  [250, 204, 21],
  [239, 68, 68],
];
// Green → Yellow → Orange → Red  (distance from home)
const RAMP_DISTANCE: [number, number, number][] = [
  [34, 197, 94],
  [250, 204, 21],
  [251, 146, 60],
  [239, 68, 68],
];

const COLOR_BY_OPTIONS: { value: ColorByMode; label: string }[] = [
  { value: 'progress', label: 'Start → End' },
  { value: 'height', label: 'Height' },
  { value: 'speed', label: 'Speed' },
  { value: 'distance', label: 'Dist. from Home' },
];

export function FlightMap({ track, homeLat, homeLon, durationSecs, themeMode }: FlightMapProps) {
  const [viewState, setViewState] = useState({
    longitude: 0,
    latitude: 0,
    zoom: 14,
    pitch: 45,
    bearing: 0,
  });
  const [is3D, setIs3D] = useState(() => getSessionBool('map:is3d', true));
  const [isSatellite, setIsSatellite] = useState(() => getSessionBool('map:isSatellite', true));
  const [colorBy, setColorBy] = useState<ColorByMode>(() => {
    if (typeof window === 'undefined') return 'progress';
    return (window.sessionStorage.getItem('map:colorBy') as ColorByMode) || 'progress';
  });
  const [showTooltip, setShowTooltip] = useState(() => getSessionBool('map:showTooltip', true));
  const [showAircraft, setShowAircraft] = useState(() => getSessionBool('map:showAircraft', true));
  const [hoverInfo, setHoverInfo] = useState<{
    x: number; y: number;
    height: number; speed: number; distance: number; progress: number;
    lat: number; lng: number;
  } | null>(null);
  const { unitSystem } = useFlightStore();
  const mapRef = useRef<MapRef | null>(null);
  const deckRef = useRef<any>(null);

  // ─── Flight replay state ────────────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(false);
  const [replayProgress, setReplayProgress] = useState(0); // 0–1
  const [replaySpeed, setReplaySpeed] = useState(1);
  const replayTimerRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);

  const resolvedTheme = useMemo(() => {
    if (themeMode === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    return themeMode;
  }, [themeMode]);

  const activeMapStyle = useMemo(
    () => (isSatellite ? SATELLITE_STYLE : MAP_STYLES[resolvedTheme]),
    [isSatellite, resolvedTheme]
  );

  // ─── Flight replay animation loop ──────────────────────────────────
  const effectiveDuration = useMemo(
    () => (durationSecs && durationSecs > 0 ? durationSecs : track.length),
    [durationSecs, track.length]
  );

  // Stop replay when track changes (new flight selected)
  useEffect(() => {
    setIsPlaying(false);
    setReplayProgress(0);
    if (replayTimerRef.current) {
      cancelAnimationFrame(replayTimerRef.current);
      replayTimerRef.current = null;
    }
  }, [track]);

  useEffect(() => {
    if (!isPlaying) {
      if (replayTimerRef.current) {
        cancelAnimationFrame(replayTimerRef.current);
        replayTimerRef.current = null;
      }
      return;
    }

    lastFrameRef.current = performance.now();

    const animate = (now: number) => {
      const dt = (now - lastFrameRef.current) / 1000; // seconds elapsed
      lastFrameRef.current = now;

      setReplayProgress((prev) => {
        const increment = (dt * replaySpeed) / effectiveDuration;
        const next = prev + increment;
        if (next >= 1) {
          setIsPlaying(false);
          return 1;
        }
        return next;
      });

      replayTimerRef.current = requestAnimationFrame(animate);
    };

    replayTimerRef.current = requestAnimationFrame(animate);

    return () => {
      if (replayTimerRef.current) {
        cancelAnimationFrame(replayTimerRef.current);
        replayTimerRef.current = null;
      }
    };
  }, [isPlaying, replaySpeed, effectiveDuration]);

  // Compute current replay marker position by interpolating along the smoothed track
  const replayMarkerPos = useMemo(() => {
    if (track.length === 0) return null;
    // Use raw track (not smoothed) so the index maps cleanly to flight time
    const n = track.length;
    const idx = replayProgress * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, n - 1);
    const frac = idx - lo;
    const lng = track[lo][0] + (track[hi][0] - track[lo][0]) * frac;
    const lat = track[lo][1] + (track[hi][1] - track[lo][1]) * frac;
    const alt = track[lo][2] + (track[hi][2] - track[lo][2]) * frac;
    return { lng, lat, alt: is3D ? alt : 0 };
  }, [track, replayProgress, is3D]);

  // Build DeckGL replay marker layers (3D-aware)
  const replayDeckLayers = useMemo(() => {
    if (!showAircraft || !replayMarkerPos || (!isPlaying && replayProgress === 0)) return [];
    const pos: [number, number, number] = [replayMarkerPos.lng, replayMarkerPos.lat, replayMarkerPos.alt];

    return [
      // Outer glow ring
      new ScatterplotLayer({
        id: 'replay-marker-glow',
        data: [{ position: pos }],
        getPosition: (d: { position: [number, number, number] }) => d.position,
        getRadius: 14,
        radiusUnits: 'pixels',
        getFillColor: [0, 212, 170, 60],
        stroked: false,
        filled: true,
        billboard: true,
        parameters: { depthTest: false },
      }),
      // Main marker dot
      new ScatterplotLayer({
        id: 'replay-marker-dot',
        data: [{ position: pos }],
        getPosition: (d: { position: [number, number, number] }) => d.position,
        getRadius: 7,
        radiusUnits: 'pixels',
        getFillColor: [0, 212, 170, 230],
        getLineColor: [255, 255, 255, 255],
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        stroked: true,
        filled: true,
        billboard: true,
        parameters: { depthTest: false },
      }),
    ];
  }, [showAircraft, replayMarkerPos, isPlaying, replayProgress]);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      setIsPlaying(false);
    } else {
      // If at end, restart from beginning
      if (replayProgress >= 1) setReplayProgress(0);
      setIsPlaying(true);
    }
  }, [isPlaying, replayProgress]);

  const handleReplaySeek = useCallback((value: number) => {
    setReplayProgress(value);
  }, []);

  const formatReplayTime = useCallback(
    (progress: number) => {
      const totalSecs = Math.round(progress * effectiveDuration);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    },
    [effectiveDuration]
  );

  // Calculate center and bounds when track changes
  useEffect(() => {
    if (track.length > 0) {
      const [lng, lat] = getTrackCenter(track);
      const bounds = calculateBounds(track);

      // Estimate zoom from bounds
      let zoom = 14;
      if (bounds) {
        const lngDiff = bounds[1][0] - bounds[0][0];
        const latDiff = bounds[1][1] - bounds[0][1];
        const maxDiff = Math.max(lngDiff, latDiff);
        zoom = Math.max(10, Math.min(18, 16 - Math.log2(maxDiff * 111)));
      }

      setViewState((prev) => ({
        ...prev,
        longitude: lng,
        latitude: lat,
        zoom,
      }));
    }
  }, [track]);

  // Smooth the raw GPS track using Catmull-Rom spline interpolation
  const smoothedTrack = useMemo(() => {
    if (track.length < 3) return track;
    // Resolution 4 = insert 4 points between each GPS sample → much smoother curves
    return smoothTrack(track, 4);
  }, [track]);

  const deckPathData = useMemo(() => {
    if (smoothedTrack.length < 2) return [];

    const toAlt = (altitude: number) => (is3D ? altitude : 0);
    const n = smoothedTrack.length;

    // Pre-compute per-point values depending on colorBy mode
    let values: number[] | null = null;
    let minVal = 0;
    let maxVal = 1;

    if (colorBy === 'height') {
      values = smoothedTrack.map((p) => p[2]);
      minVal = Math.min(...values);
      maxVal = Math.max(...values);
    } else if (colorBy === 'speed') {
      // Approximate speed from consecutive point distance
      values = [0];
      for (let i = 1; i < n; i++) {
        const d = haversineM(
          smoothedTrack[i - 1][1], smoothedTrack[i - 1][0],
          smoothedTrack[i][1], smoothedTrack[i][0]
        );
        values.push(d); // proportional to speed (uniform time steps after smoothing)
      }
      minVal = Math.min(...values);
      maxVal = Math.max(...values);
    } else if (colorBy === 'distance') {
      const hLat = homeLat ?? smoothedTrack[0][1];
      const hLon = homeLon ?? smoothedTrack[0][0];
      values = smoothedTrack.map((p) => haversineM(hLat, hLon, p[1], p[0]));
      minVal = Math.min(...values);
      maxVal = Math.max(...values);
    }

    const range = maxVal - minVal || 1;

    const getRamp = () => {
      switch (colorBy) {
        case 'height': return RAMP_HEIGHT;
        case 'speed': return RAMP_SPEED;
        case 'distance': return RAMP_DISTANCE;
        default: return RAMP_PROGRESS;
      }
    };
    const ramp = getRamp();

    // Pre-compute per-point speed and distance for tooltip (always, regardless of colorBy)
    const speeds: number[] = [0];
    for (let i = 1; i < n; i++) {
      speeds.push(
        haversineM(smoothedTrack[i - 1][1], smoothedTrack[i - 1][0], smoothedTrack[i][1], smoothedTrack[i][0])
      );
    }
    const hLat = homeLat ?? smoothedTrack[0][1];
    const hLon = homeLon ?? smoothedTrack[0][0];
    const distances: number[] = smoothedTrack.map((p) => haversineM(hLat, hLon, p[1], p[0]));

    const segments: {
      path: [number, number, number][];
      color: [number, number, number];
      meta: { height: number; speed: number; distance: number; progress: number; lat: number; lng: number };
    }[] = [];

    for (let i = 0; i < n - 1; i++) {
      const t = values ? (values[i] - minVal) / range : i / Math.max(1, n - 2);
      const color = valueToColor(t, ramp);
      const [lng1, lat1, alt1] = smoothedTrack[i];
      const [lng2, lat2, alt2] = smoothedTrack[i + 1];
      segments.push({
        path: [
          [lng1, lat1, toAlt(alt1)],
          [lng2, lat2, toAlt(alt2)],
        ],
        color,
        meta: {
          height: smoothedTrack[i][2],
          speed: speeds[i],
          distance: distances[i],
          progress: i / Math.max(1, n - 2),
          lat: lat1,
          lng: lng1,
        },
      });
    }

    return segments;
  }, [is3D, smoothedTrack, colorBy, homeLat, homeLon]);

  const deckLayers = useMemo(() => {
    if (deckPathData.length === 0) return [];
    return [
      // Shadow / outline layer
      new PathLayer({
        id: 'flight-path-shadow',
        data: deckPathData,
        getPath: (d) => d.path,
        getColor: [0, 0, 0, 40],
        getWidth: 7,
        widthUnits: 'pixels',
        widthMinPixels: 6,
        capRounded: true,
        jointRounded: true,
        billboard: true,
        opacity: 1,
        pickable: false,
        parameters: { depthTest: false },
      }),
      // Main gradient path layer — pickable when tooltip is on
      new PathLayer({
        id: 'flight-path-3d',
        data: deckPathData,
        getPath: (d) => d.path,
        getColor: (d) => d.color,
        getWidth: 4,
        widthUnits: 'pixels',
        widthMinPixels: 3,
        capRounded: true,
        jointRounded: true,
        billboard: true,
        opacity: 1,
        pickable: showTooltip,
        parameters: { depthTest: false },
      }),
    ];
  }, [deckPathData, showTooltip]);

  // Start and end markers
  const startPoint = track[0];
  const endPoint = track[track.length - 1];

  const handleMapMove = useCallback(
    ({ viewState: nextViewState }: { viewState: typeof viewState }) => {
      setViewState(nextViewState);
    },
    []
  );

  const enableTerrain = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    try {
      if (!map.getSource(TERRAIN_SOURCE_ID)) {
        map.addSource(TERRAIN_SOURCE_ID, TERRAIN_SOURCE);
      }
      map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1.4 });
    } catch (e) {
      console.warn('[FlightMap] Failed to enable terrain:', e);
    }
  }, []);

  const disableTerrain = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    map.setTerrain(null);
  }, []);

  useEffect(() => {
    if (is3D) {
      enableTerrain();
      setViewState((prev) => ({ ...prev, pitch: 60 }));
    } else {
      disableTerrain();
      setViewState((prev) => ({ ...prev, pitch: 0 }));
    }
  }, [disableTerrain, enableTerrain, is3D]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:is3d', String(is3D));
    }
  }, [is3D]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:isSatellite', String(isSatellite));
    }
  }, [isSatellite]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:colorBy', colorBy);
    }
  }, [colorBy]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:showTooltip', String(showTooltip));
    }
    if (!showTooltip) setHoverInfo(null);
  }, [showTooltip]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:showAircraft', String(showAircraft));
    }
    if (!showAircraft) {
      setIsPlaying(false);
      setReplayProgress(0);
    }
  }, [showAircraft]);

  useEffect(() => {
    if (is3D) {
      enableTerrain();
    }
  }, [enableTerrain, is3D, resolvedTheme]);

  if (track.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-dji-dark">
        <p className="text-gray-500">No GPS data available</p>
      </div>
    );
  }

  return (
    <div
      className="relative h-full w-full min-h-0"
      onMouseMove={(e) => {
        if (!showTooltip || !deckRef.current) {
          if (hoverInfo) setHoverInfo(null);
          return;
        }
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const deck = deckRef.current.deck;
        if (!deck) { setHoverInfo(null); return; }
        const picked = deck.pickObject({ x, y, radius: 12 });
        if (picked?.object?.meta) {
          const { meta } = picked.object;
          setHoverInfo({ x, y, ...meta });
        } else {
          setHoverInfo(null);
        }
      }}
      onMouseLeave={() => { if (hoverInfo) setHoverInfo(null); }}
    >
      <Map
        {...viewState}
        maxZoom={22}
        style={{ width: '100%', height: '100%', position: 'absolute', top: '0', right: '0', bottom: '0', left: '0' }}
        mapStyle={activeMapStyle}
        attributionControl={false}
        ref={mapRef}
        onMove={handleMapMove}
        onLoad={() => {
          if (is3D) {
            enableTerrain();
          }
        }}
      >
        <NavigationControl position="top-right" />

        {/* Map Controls */}
        <div className="map-overlay absolute top-2 left-2 z-10 bg-dji-dark/80 border border-gray-700 rounded-xl px-3 py-2 space-y-2 shadow-lg">
          <ToggleRow
            label="3D Terrain"
            checked={is3D}
            onChange={setIs3D}
          />
          <ToggleRow
            label="Satellite"
            checked={isSatellite}
            onChange={setIsSatellite}
          />
          <ToggleRow
            label="Tooltip"
            checked={showTooltip}
            onChange={setShowTooltip}
          />
          <ToggleRow
            label="Aircraft"
            checked={showAircraft}
            onChange={setShowAircraft}
          />

          {/* Color-by dropdown */}
          <div className="pt-1 border-t border-gray-600/50">
            <label className="block text-[10px] text-gray-400 mb-1 uppercase tracking-wide">Color by</label>
            <select
              value={colorBy}
              onChange={(e) => setColorBy(e.target.value as ColorByMode)}
              className="map-select w-full text-xs bg-dji-surface border border-gray-600 text-gray-200 rounded-md px-2 py-1 focus:outline-none focus:border-dji-primary appearance-none cursor-pointer"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%239ca3af' fill='none' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center', paddingRight: '22px' }}
            >
              {COLOR_BY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Start Marker — pulsing yellow */}
        {startPoint && (
          <Marker longitude={startPoint[0]} latitude={startPoint[1]} anchor="center">
            <div className="relative flex items-center justify-center">
              <div className="absolute w-7 h-7 bg-yellow-400/30 rounded-full animate-ping" />
              <div className="w-4 h-4 bg-yellow-400 rounded-full border-2 border-white shadow-lg z-10" />
              <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] font-semibold bg-yellow-500 text-black px-1.5 py-0.5 rounded shadow whitespace-nowrap z-10">
                START
              </div>
            </div>
          </Marker>
        )}

        {/* End Marker — red with landing icon */}
        {endPoint && (
          <Marker longitude={endPoint[0]} latitude={endPoint[1]} anchor="center">
            <div className="relative flex items-center justify-center">
              <div className="w-5 h-5 bg-red-500 rounded-full border-2 border-white shadow-lg flex items-center justify-center z-10">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M5 2V8M3 6L5 8L7 6" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] font-semibold bg-red-500 text-white px-1.5 py-0.5 rounded shadow whitespace-nowrap z-10">
                END
              </div>
            </div>
          </Marker>
        )}

        {/* Home Marker — "H" in a circle */}
        {homeLat != null && homeLon != null && Math.abs(homeLat) > 0.000001 && (
          <Marker longitude={homeLon} latitude={homeLat} anchor="center">
            <div className="w-6 h-6 rounded-full border-2 border-white bg-sky-500 flex items-center justify-center shadow-lg">
              <span className="text-[11px] font-bold text-white leading-none">H</span>
            </div>
          </Marker>
        )}
      </Map>

      <DeckGL
        ref={deckRef}
        viewState={viewState}
        controller={false}
        layers={[...deckLayers, ...replayDeckLayers]}
        pickingRadius={12}
        style={{
          width: '100%', height: '100%',
          pointerEvents: 'none',
          position: 'absolute', top: '0', right: '0', bottom: '0', left: '0',
          zIndex: '1',
        }}
      />

      {/* Hover tooltip */}
      {hoverInfo && showTooltip && (
        <div
          className="pointer-events-none absolute z-50"
          style={{ left: hoverInfo.x + 12, top: hoverInfo.y - 60 }}
        >
          <div className="map-tooltip bg-gray-900/95 backdrop-blur-sm border border-gray-600/60 rounded-lg px-3 py-2 shadow-xl text-[11px] text-gray-200 space-y-0.5 min-w-[160px]">
            {durationSecs != null && durationSecs > 0 && (
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">Flight Time</span>
                <span className="font-medium text-white">
                  {(() => { const s = Math.round(hoverInfo.progress * durationSecs); const m = Math.floor(s / 60); return `${m}m ${s % 60}s`; })()}
                </span>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">Height</span>
              <span className="font-medium text-white">{formatAltitude(hoverInfo.height, unitSystem)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">Speed</span>
              <span className="font-medium text-white">{formatSpeed(hoverInfo.speed, unitSystem)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">Dist. Home</span>
              <span className="font-medium text-white">{formatDistance(hoverInfo.distance, unitSystem)}</span>
            </div>
            <div className="border-t border-gray-700/60 mt-1 pt-1 flex justify-between gap-4">
              <span className="text-gray-500">Lat</span>
              <span className="text-gray-400">{hoverInfo.lat.toFixed(6)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-500">Lng</span>
              <span className="text-gray-400">{hoverInfo.lng.toFixed(6)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Flight Replay Controls */}
      {showAircraft && track.length > 1 ? (
        <div
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 bg-dji-dark/90 backdrop-blur-sm border border-gray-700 rounded-xl px-3 py-2 shadow-xl flex items-center gap-3 min-w-[280px] max-w-[460px] w-[90%] sm:w-auto pointer-events-auto"
        >
          {/* Play / Pause */}
          <button
            type="button"
            onClick={handlePlayPause}
            className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-dji-accent/20 text-dji-accent hover:bg-dji-accent/30 transition-colors"
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <rect x="2" y="1" width="4" height="12" rx="1" />
                <rect x="8" y="1" width="4" height="12" rx="1" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <path d="M3 1.5V12.5L12 7L3 1.5Z" />
              </svg>
            )}
          </button>

          {/* Time */}
          <span className="text-[11px] text-gray-400 tabular-nums flex-shrink-0 w-[36px] text-right">
            {formatReplayTime(replayProgress)}
          </span>

          {/* Seek Slider */}
          <input
            type="range"
            min="0"
            max="1"
            step="0.001"
            value={replayProgress}
            onChange={(e) => handleReplaySeek(Number(e.target.value))}
            className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer replay-slider"
            style={{
              background: `linear-gradient(to right, rgb(var(--dji-accent)) ${replayProgress * 100}%, #4a4e69 ${replayProgress * 100}%)`,
            }}
          />

          {/* End Time */}
          <span className="text-[11px] text-gray-400 tabular-nums flex-shrink-0 w-[36px]">
            {formatReplayTime(1)}
          </span>

          {/* Speed */}
          <select
            value={replaySpeed}
            onChange={(e) => setReplaySpeed(Number(e.target.value))}
            className="flex-shrink-0 text-[11px] bg-transparent text-gray-300 border border-gray-600 rounded-md px-1.5 py-0.5 focus:outline-none cursor-pointer appearance-none text-center w-[42px]"
          >
            <option value={0.5}>½×</option>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
            <option value={8}>8×</option>
            <option value={16}>16×</option>
          </select>
        </div>
      ) : null}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between gap-3 text-xs text-gray-300 hover:text-white transition-colors"
      aria-pressed={checked}
    >
      <span>{label}</span>
      <span
        className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${
          checked
            ? 'bg-dji-primary/90 border-dji-primary'
            : 'bg-dji-surface border-gray-600'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-1'
          }`}
        />
      </span>
    </button>
  );
}
