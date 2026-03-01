/**
 * Telemetry charts component using ECharts
 * Displays height, VPS height, speed, battery, attitude, RC, GPS, distance to home, and velocity data
 * Optimized for performance with large datasets
 */

import { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption, ECharts, LineSeriesOption } from 'echarts';
import type { TelemetryData } from '@/types';
import type { UnitSystem } from '@/lib/utils';
import { useFlightStore } from '@/stores/flightStore';

// ============================================================================
// TELEMETRY FIELD DEFINITIONS
// ============================================================================

/** Definition of a telemetry field that can be plotted */
interface TelemetryFieldDef {
  id: string;
  label: string;
  color: string;
  /** The key in TelemetryData to get raw values */
  dataKey: keyof TelemetryData | 'distanceToHome';
  /** Unit string (may be overridden by unitSystem) */
  unit: string;
  /** Unit string for imperial system */
  unitImperial?: string;
  /** Conversion factor for metric (applied to raw m/s values) */
  metricFactor?: number;
  /** Conversion factor for imperial (applied to raw m/s values) */
  imperialFactor?: number;
  /** Group this field belongs to for organization */
  group: 'altitude' | 'speed' | 'battery' | 'attitude' | 'rc' | 'gps' | 'velocity';
}

/** All available telemetry fields that can be plotted */
const TELEMETRY_FIELDS: TelemetryFieldDef[] = [
  // Altitude group
  { id: 'height', label: 'Height', color: '#00A0DC', dataKey: 'height', unit: 'm', unitImperial: 'ft', metricFactor: 1, imperialFactor: 3.28084, group: 'altitude' },
  { id: 'vpsHeight', label: 'VPS Height', color: '#f97316', dataKey: 'vpsHeight', unit: 'm', unitImperial: 'ft', metricFactor: 1, imperialFactor: 3.28084, group: 'altitude' },
  { id: 'altitude', label: 'Altitude (GPS)', color: '#22d3ee', dataKey: 'altitude', unit: 'm', unitImperial: 'ft', metricFactor: 1, imperialFactor: 3.28084, group: 'altitude' },
  
  // Speed group
  { id: 'speed', label: 'Speed', color: '#00D4AA', dataKey: 'speed', unit: 'km/h', unitImperial: 'mph', metricFactor: 3.6, imperialFactor: 2.236936, group: 'speed' },
  { id: 'velocityX', label: 'X Speed', color: '#ef4444', dataKey: 'velocityX', unit: 'km/h', unitImperial: 'mph', metricFactor: 3.6, imperialFactor: 2.236936, group: 'velocity' },
  { id: 'velocityY', label: 'Y Speed', color: '#a855f7', dataKey: 'velocityY', unit: 'km/h', unitImperial: 'mph', metricFactor: 3.6, imperialFactor: 2.236936, group: 'velocity' },
  { id: 'velocityZ', label: 'Z Speed', color: '#7c3aed', dataKey: 'velocityZ', unit: 'km/h', unitImperial: 'mph', metricFactor: 3.6, imperialFactor: 2.236936, group: 'velocity' },
  
  // Battery group
  { id: 'battery', label: 'Battery %', color: '#f59e0b', dataKey: 'battery', unit: '%', group: 'battery' },
  { id: 'batteryVoltage', label: 'Voltage', color: '#3b82f6', dataKey: 'batteryVoltage', unit: 'V', group: 'battery' },
  { id: 'batteryTemp', label: 'Temperature', color: '#e11d48', dataKey: 'batteryTemp', unit: '°C', group: 'battery' },
  
  // Attitude group
  { id: 'pitch', label: 'Pitch', color: '#8b5cf6', dataKey: 'pitch', unit: '°', group: 'attitude' },
  { id: 'roll', label: 'Roll', color: '#ec4899', dataKey: 'roll', unit: '°', group: 'attitude' },
  { id: 'yaw', label: 'Yaw', color: '#14b8a6', dataKey: 'yaw', unit: '°', group: 'attitude' },
  
  // RC group
  { id: 'rcSignal', label: 'RC Signal', color: '#22c55e', dataKey: 'rcSignal', unit: '%', group: 'rc' },
  { id: 'rcUplink', label: 'RC Uplink', color: '#84cc16', dataKey: 'rcUplink', unit: '%', group: 'rc' },
  { id: 'rcDownlink', label: 'RC Downlink', color: '#0369a1', dataKey: 'rcDownlink', unit: '%', group: 'rc' },
  
  // GPS group
  { id: 'satellites', label: 'GPS Satellites', color: '#0ea5e9', dataKey: 'satellites', unit: '', group: 'gps' },
  { id: 'distanceToHome', label: 'Distance to Home', color: '#10b981', dataKey: 'distanceToHome', unit: 'm', unitImperial: 'ft', metricFactor: 1, imperialFactor: 3.28084, group: 'gps' },
  
  // Cell Voltages (virtual field that expands to all available cells)
  { id: 'allCellVoltages', label: 'Cell Voltages', color: '#fbbf24', dataKey: 'cellVoltages', unit: 'V', group: 'battery' },
];

/** Get field definition by id */
function getFieldDef(id: string): TelemetryFieldDef | undefined {
  return TELEMETRY_FIELDS.find(f => f.id === id);
}

/** Get data series for a field with unit conversion applied */
function getFieldData(
  fieldId: string,
  data: TelemetryData,
  unitSystem: UnitSystem
): (number | null)[] {
  const field = getFieldDef(fieldId);
  if (!field) return [];

  // allCellVoltages is handled specially in createDynamicChart, not here
  if (fieldId === 'allCellVoltages') {
    return [];
  }

  // Special handling for distanceToHome (computed field)
  if (field.dataKey === 'distanceToHome') {
    const distances = computeDistanceToHomeSeries(data);
    const factor = unitSystem === 'imperial' ? (field.imperialFactor ?? 1) : (field.metricFactor ?? 1);
    return distances.map(v => v === null ? null : v * factor);
  }

  // Special handling for height - use altitude as fallback
  if (fieldId === 'height') {
    const hasHeight = data.height.some((val) => val !== null);
    const heightSource = hasHeight ? data.height : (data.altitude ?? []);
    const factor = unitSystem === 'imperial' ? (field.imperialFactor ?? 1) : (field.metricFactor ?? 1);
    return heightSource.map(v => v === null ? null : v * factor);
  }

  const rawData = data[field.dataKey as keyof TelemetryData];
  if (!rawData || !Array.isArray(rawData)) return [];

  // Apply unit conversion
  const factor = unitSystem === 'imperial' 
    ? (field.imperialFactor ?? 1) 
    : (field.metricFactor ?? 1);

  return (rawData as (number | null)[]).map(v => 
    v === null || v === undefined ? null : v * factor
  );
}

/** Get the unit string for a field based on unit system */
function getFieldUnit(fieldId: string, unitSystem: UnitSystem): string {
  const field = getFieldDef(fieldId);
  if (!field) return '';
  return unitSystem === 'imperial' && field.unitImperial ? field.unitImperial : field.unit;
}

/** Get a descriptive category label for a unit when multiple series share it */
function getUnitCategoryLabel(unit: string): string {
  const unitCategories: Record<string, string> = {
    'm': 'Distance (m)',
    'ft': 'Distance (ft)',
    'km/h': 'Speed (km/h)',
    'mph': 'Speed (mph)',
    '°': 'Degrees (°)',
    '%': 'Percent (%)',
    'V': 'Voltage (V)',
    '°C': 'Temperature (°C)',
  };
  return unitCategories[unit] || unit;
}

/** Create a dynamic chart based on selected fields */
function createDynamicChart(
  selectedFieldIds: string[],
  data: TelemetryData,
  unitSystem: UnitSystem,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption | null {
  if (selectedFieldIds.length === 0) return null;

  // Check if allCellVoltages is selected
  const hasAllCellVoltages = selectedFieldIds.includes('allCellVoltages');
  const otherFieldIds = selectedFieldIds.filter(id => id !== 'allCellVoltages');

  // Get other fields
  const otherFields = otherFieldIds
    .map(id => getFieldDef(id))
    .filter((f): f is TelemetryFieldDef => f !== undefined);

  // Build cell voltage series if selected
  const cellVoltageColors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#a855f7'];
  let cellVoltageSeries: { label: string; data: (number | null)[]; color: string; unit: string }[] = [];
  
  if (hasAllCellVoltages) {
    const cellVoltages = data.cellVoltages;
    if (cellVoltages && cellVoltages.length > 0) {
      const firstValidEntry = cellVoltages.find((v) => v !== null && v !== undefined);
      if (firstValidEntry) {
        const numCells = firstValidEntry.length;
        for (let i = 0; i < numCells; i++) {
          const cellData = cellVoltages.map(voltages => {
            if (voltages && voltages[i] !== undefined && voltages[i] !== null && voltages[i] !== 0) {
              return voltages[i];
            }
            return null;
          });
          cellVoltageSeries.push({
            label: `Cell ${i + 1}`,
            data: cellData,
            color: cellVoltageColors[i % cellVoltageColors.length],
            unit: 'V',
          });
        }
      }
    }
  }

  // Get data series for other fields
  const regularSeriesData = otherFields.map(field => ({
    field,
    data: getFieldData(field.id, data, unitSystem),
    unit: getFieldUnit(field.id, unitSystem),
  }));

  // If only allCellVoltages and no cell data, return null
  if (otherFields.length === 0 && cellVoltageSeries.length === 0) return null;

  // Combine all series
  const allSeriesData: { label: string; data: (number | null)[]; color: string; unit: string }[] = [
    ...regularSeriesData.map(s => ({ label: s.field.label, data: s.data, color: s.field.color, unit: s.unit })),
    ...cellVoltageSeries,
  ];

  if (allSeriesData.length === 0) return null;

  // Create legend data
  const legendData = allSeriesData.map(s => s.label);

  // Group series by unit to share y-axis scales
  const unitGroups = new Map<string, { indices: number[]; data: (number | null)[] }>();
  allSeriesData.forEach((s, index) => {
    const unitKey = s.unit || '__no_unit__';
    if (!unitGroups.has(unitKey)) {
      unitGroups.set(unitKey, { indices: [], data: [] });
    }
    const group = unitGroups.get(unitKey)!;
    group.indices.push(index);
    group.data.push(...s.data);
  });

  // Assign y-axis indices based on unique units (max 2 axes)
  const uniqueUnits = Array.from(unitGroups.keys());
  const unitToAxisIndex = new Map<string, number>();
  uniqueUnits.forEach((unit, idx) => {
    unitToAxisIndex.set(unit, Math.min(idx, 1)); // Clamp to max 2 axes (index 0 and 1)
  });

  // Compute combined ranges for each unit group
  const unitRanges = new Map<string, { min?: number; max?: number }>();
  for (const [unit, group] of unitGroups) {
    unitRanges.set(unit, computeRange(group.data));
  }

  // Create series with y-axis index based on unit
  const series: LineSeriesOption[] = allSeriesData.map((s, index) => {
    const unitKey = s.unit || '__no_unit__';
    const yAxisIndex = allSeriesData.length > 1 ? unitToAxisIndex.get(unitKey) ?? 0 : 0;
    return {
      name: s.label,
      type: 'line',
      data: s.data,
      yAxisIndex,
      smooth: true,
      symbol: 'none',
      itemStyle: { color: s.color },
      lineStyle: { color: s.color, width: index === 0 ? 2 : 1.5 },
      ...(index === 0 ? {
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: `${s.color}4d` },
              { offset: 1, color: `${s.color}0d` },
            ],
          },
        },
      } : {}),
    };
  });

  // Create Y-axes based on unique units (max 2)
  const yAxis: any[] = [];
  const axisUnits = uniqueUnits.slice(0, 2); // Max 2 axes
  axisUnits.forEach((unit, axisIndex) => {
    const group = unitGroups.get(unit)!;
    const range = unitRanges.get(unit)!;
    // Use the first series with this unit for display properties
    const firstSeriesIndex = group.indices[0];
    const s = allSeriesData[firstSeriesIndex];
    // Build axis name: if multiple series share this unit, show descriptive category; otherwise show label with unit
    const seriesWithUnit = group.indices.map(i => allSeriesData[i]);
    const axisName = seriesWithUnit.length > 1 && s.unit
      ? getUnitCategoryLabel(s.unit)
      : (s.unit ? `${s.label} (${s.unit})` : s.label);
    yAxis.push({
      type: 'value',
      name: axisName,
      min: range.min,
      max: range.max,
      nameTextStyle: { color: s.color },
      axisLine: { lineStyle: { color: s.color } },
      axisLabel: { color: '#9ca3af' },
      splitLine: { lineStyle: { color: splitLineColor }, show: axisIndex === 0 },
    });
  });

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: legendData,
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis,
    series,
  };
}

// ============================================================================
// CHART CONFIGURATION TYPES & PERSISTENCE
// ============================================================================

/** Configuration for a single chart panel */
interface ChartPanelConfig {
  /** Custom title (null = use default) */
  title: string | null;
  /** Selected field IDs to plot (max 3) */
  selectedFields: string[];
}

/** All chart configurations keyed by chart ID */
interface TelemetryChartsConfig {
  altitudeSpeed: ChartPanelConfig;
  battery: ChartPanelConfig;
  cellVoltage: ChartPanelConfig;
  attitude: ChartPanelConfig;
  rcSignal: ChartPanelConfig;
  distanceToHome: ChartPanelConfig;
  velocity: ChartPanelConfig;
  gps: ChartPanelConfig;
}

/** Default configuration for all charts */
const DEFAULT_CHART_CONFIGS: TelemetryChartsConfig = {
  altitudeSpeed: { title: null, selectedFields: ['height', 'vpsHeight', 'speed'] },
  battery: { title: null, selectedFields: ['battery', 'batteryVoltage', 'batteryTemp'] },
  cellVoltage: { title: null, selectedFields: ['allCellVoltages'] },
  attitude: { title: null, selectedFields: ['pitch', 'roll', 'yaw'] },
  rcSignal: { title: null, selectedFields: ['rcSignal'] }, // Will be overridden if uplink/downlink available
  distanceToHome: { title: null, selectedFields: ['distanceToHome'] },
  velocity: { title: null, selectedFields: ['velocityX', 'velocityY', 'velocityZ'] },
  gps: { title: null, selectedFields: ['satellites'] },
};

const CHART_CONFIG_STORAGE_KEY = 'telemetryChartConfigs';

/** Load chart configurations from localStorage */
function loadChartConfigs(): TelemetryChartsConfig {
  try {
    const stored = localStorage.getItem(CHART_CONFIG_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Deep merge with defaults to ensure all keys exist and no empty arrays
      const result = { ...DEFAULT_CHART_CONFIGS };
      for (const key of Object.keys(DEFAULT_CHART_CONFIGS) as (keyof TelemetryChartsConfig)[]) {
        if (parsed[key]) {
          result[key] = {
            ...DEFAULT_CHART_CONFIGS[key],
            ...parsed[key],
            // Ensure selectedFields is never empty - use default if stored is empty
            selectedFields: parsed[key].selectedFields?.length > 0 
              ? parsed[key].selectedFields 
              : DEFAULT_CHART_CONFIGS[key].selectedFields,
          };
        }
      }
      return result;
    }
  } catch (e) {
    console.warn('Failed to load telemetry chart configs:', e);
  }
  return { ...DEFAULT_CHART_CONFIGS };
}

/** Save chart configurations to localStorage */
function saveChartConfigs(configs: TelemetryChartsConfig): void {
  try {
    localStorage.setItem(CHART_CONFIG_STORAGE_KEY, JSON.stringify(configs));
  } catch (e) {
    console.warn('Failed to save telemetry chart configs:', e);
  }
}

// ============================================================================
// CHART HEADER COMPONENT (Title + Multi-Select)
// ============================================================================

interface ChartHeaderProps {
  config: ChartPanelConfig;
  availableFields: TelemetryFieldDef[];
  onFieldsChange: (fields: string[]) => void;
  unitSystem: UnitSystem;
  theme: 'dark' | 'light';
}

function ChartHeader({
  config,
  availableFields,
  onFieldsChange,
  unitSystem,
  theme,
}: ChartHeaderProps) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Filter available fields by search
  const filteredFields = useMemo(() => {
    if (!searchQuery.trim()) return availableFields;
    const q = searchQuery.toLowerCase();
    return availableFields.filter(f => f.label.toLowerCase().includes(q));
  }, [availableFields, searchQuery]);

  // Sort: selected first, then alphabetically
  const sortedFields = useMemo(() => {
    return [...filteredFields].sort((a, b) => {
      const aSelected = config.selectedFields.includes(a.id);
      const bSelected = config.selectedFields.includes(b.id);
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;
      return a.label.localeCompare(b.label);
    });
  }, [filteredFields, config.selectedFields]);

  const handleFieldToggle = useCallback((fieldId: string) => {
    const isSelected = config.selectedFields.includes(fieldId);
    if (isSelected) {
      // Don't allow deselecting the last item - must have at least 1 selection
      if (config.selectedFields.length <= 1) return;
      onFieldsChange(config.selectedFields.filter(f => f !== fieldId));
    } else if (config.selectedFields.length < 4) {
      onFieldsChange([...config.selectedFields, fieldId]);
    }
  }, [config.selectedFields, onFieldsChange]);

  const getFieldUnit = useCallback((field: TelemetryFieldDef) => {
    if (unitSystem === 'imperial' && field.unitImperial) {
      return field.unitImperial;
    }
    return field.unit;
  }, [unitSystem]);

  const isLight = theme === 'light';

  // Don't render if no fields available
  if (availableFields.length === 0) return null;

  return (
    <div className="flex items-center justify-start mb-1 px-1">
      {/* Multi-Select Dropdown - Left side, bigger with highlighted border */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setIsDropdownOpen(v => !v)}
          className={`text-[11px] h-6 px-2.5 py-1 flex items-center gap-1.5 rounded-md border-2 transition-colors ${
            isLight
              ? 'bg-gray-100 border-sky-400 text-gray-700 hover:bg-gray-200 hover:border-sky-500'
              : 'bg-drone-surface border-sky-500/60 text-gray-300 hover:bg-gray-700 hover:border-sky-400'
          }`}
          title="Select data to plot (max 4)"
        >
          <span className="font-medium">{config.selectedFields.length}/4</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {isDropdownOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => { setIsDropdownOpen(false); setSearchQuery(''); }}
            />
            <div
              ref={dropdownRef}
              className={`absolute left-0 top-full mt-1 z-50 w-52 max-h-64 rounded-lg border-2 shadow-xl flex flex-col overflow-hidden ${
                isLight
                  ? 'bg-white border-sky-400'
                  : 'bg-drone-surface border-sky-500/60'
              }`}
            >
              {/* Search input */}
              <div className={`px-2 pt-2 pb-1 border-b flex-shrink-0 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setHighlightedIndex(0); }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setHighlightedIndex(prev => prev < sortedFields.length - 1 ? prev + 1 : 0);
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setHighlightedIndex(prev => prev > 0 ? prev - 1 : sortedFields.length - 1);
                    } else if (e.key === 'Enter' && sortedFields.length > 0) {
                      e.preventDefault();
                      const field = sortedFields[highlightedIndex];
                      if (field) handleFieldToggle(field.id);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setIsDropdownOpen(false);
                      setSearchQuery('');
                    }
                  }}
                  placeholder="Search fields…"
                  autoFocus
                  className={`w-full text-[11px] rounded px-2 py-1 border focus:outline-none ${
                    isLight
                      ? 'bg-gray-50 text-gray-800 border-gray-300 focus:border-sky-500 placeholder-gray-400'
                      : 'bg-drone-dark text-gray-200 border-gray-600 focus:border-drone-primary placeholder-gray-500'
                  }`}
                />
              </div>

              {/* Field list */}
              <div className="overflow-auto flex-1">
                {sortedFields.length === 0 ? (
                  <p className={`text-[11px] px-3 py-2 ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>
                    No matching fields
                  </p>
                ) : (
                  sortedFields.map((field, index) => {
                    const isSelected = config.selectedFields.includes(field.id);
                    // Disable if: max selections reached (for unselected), or it's the only selection (can't deselect last)
                    const isLastSelected = isSelected && config.selectedFields.length === 1;
                    const isDisabled = isLastSelected || (!isSelected && config.selectedFields.length >= 4);
                    return (
                      <button
                        key={field.id}
                        type="button"
                        onClick={() => !isDisabled && handleFieldToggle(field.id)}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        disabled={isDisabled}
                        className={`w-full text-left px-2.5 py-1.5 text-[11px] flex items-center gap-2 transition-colors ${
                          isDisabled && isLastSelected
                            ? isLight ? 'bg-sky-100/50 text-sky-600 cursor-not-allowed' : 'bg-sky-500/10 text-sky-300 cursor-not-allowed'
                            : isDisabled
                              ? isLight ? 'text-gray-400 cursor-not-allowed' : 'text-gray-600 cursor-not-allowed'
                              : isSelected
                                ? isLight ? 'bg-sky-100 text-sky-800' : 'bg-sky-500/20 text-sky-200'
                                : index === highlightedIndex
                                  ? isLight ? 'bg-gray-100' : 'bg-gray-700/50'
                                  : isLight ? 'text-gray-700 hover:bg-gray-50' : 'text-gray-300 hover:bg-gray-700/50'
                        }`}
                        title={isLastSelected ? 'Cannot deselect the last item' : undefined}
                      >
                        <span
                          className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                            isSelected
                              ? 'border-sky-500 bg-sky-500'
                              : isLight ? 'border-gray-400' : 'border-gray-600'
                          }`}
                        >
                          {isSelected && (
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </span>
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: field.color }}
                        />
                        <span className="truncate flex-1">{field.label}</span>
                        <span className={`flex-shrink-0 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                          {getFieldUnit(field)}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT TYPES
// ============================================================================

interface TelemetryChartsProps {
  data: TelemetryData;
  unitSystem: UnitSystem;
  startTime?: string | null;
}

export function TelemetryCharts({ data, unitSystem, startTime }: TelemetryChartsProps) {
  const chartsRef = useRef<ECharts[]>([]);
  const isSyncingRef = useRef(false);
  const themeMode = useFlightStore((state) => state.themeMode);
  const locale = useFlightStore((state) => state.locale);
  const mapSyncEnabled = useFlightStore((state) => state.mapSyncEnabled);
  const setMapSyncEnabled = useFlightStore((state) => state.setMapSyncEnabled);
  const mapReplayProgress = useFlightStore((state) => state.mapReplayProgress);
  const resolvedTheme = useMemo(() => resolveThemeMode(themeMode), [themeMode]);
  const splitLineColor = resolvedTheme === 'light' ? '#e2e8f0' : '#2a2a4e';
  const tooltipFormatter = useMemo(
    () => createTooltipFormatter(startTime ?? null, resolvedTheme, locale),
    [resolvedTheme, startTime, locale]
  );
  const tooltipColors = useMemo(
    () =>
      resolvedTheme === 'light'
        ? {
            background: '#ffffff',
            border: '#e2e8f0',
            text: '#0f172a',
          }
        : {
            background: '#16213e',
            border: '#4a4e69',
            text: '#ffffff',
          },
    [resolvedTheme]
  );

  // Chart configuration state (persisted to localStorage)
  const [chartConfigs, setChartConfigs] = useState<TelemetryChartsConfig>(() => loadChartConfigs());

  // Persist configuration changes
  const updateChartConfig = useCallback((
    chartId: keyof TelemetryChartsConfig,
    updates: Partial<ChartPanelConfig>
  ) => {
    setChartConfigs(prev => {
      const newConfigs = {
        ...prev,
        [chartId]: { ...prev[chartId], ...updates },
      };
      saveChartConfigs(newConfigs);
      return newConfigs;
    });
  }, []);

  // Update module-level base config when theme changes
  useMemo(() => {
    baseChartConfig = createBaseChartConfig(resolvedTheme);
    return resolvedTheme;
  }, [resolvedTheme]);

  const [dragZoomActive, setDragZoomActive] = useState(true);

  const toggleDragZoom = useCallback(() => {
    setDragZoomActive((prev) => {
      const next = !prev;
      chartsRef.current.forEach((chart) => {
        chart.dispatchAction({
          type: 'takeGlobalCursor',
          key: 'dataZoomSelect',
          dataZoomSelectActive: next,
        });
      });
      return next;
    });
  }, []);

  const resetZoom = useCallback(() => {
    chartsRef.current.forEach((chart) => {
      chart.dispatchAction({
        type: 'dataZoom',
        start: 0,
        end: 100,
      });
    });
  }, []);

  const resetSelections = useCallback(() => {
    setChartConfigs({ ...DEFAULT_CHART_CONFIGS });
    saveChartConfigs({ ...DEFAULT_CHART_CONFIGS });
  }, []);

  const syncZoom = useCallback((sourceChart: ECharts) => {
    if (isSyncingRef.current) return;
    const dataZoom = sourceChart.getOption().dataZoom as
      | { start?: number; end?: number; startValue?: number; endValue?: number }[]
      | undefined;
    if (!dataZoom || dataZoom.length === 0) return;

    const { start, end, startValue, endValue } = dataZoom[0] ?? {};

    isSyncingRef.current = true;
    chartsRef.current.forEach((chart) => {
      if (chart === sourceChart) return;
      chart.dispatchAction({
        type: 'dataZoom',
        start,
        end,
        startValue,
        endValue,
      });
    });
    window.setTimeout(() => {
      isSyncingRef.current = false;
    }, 0);
  }, []);

  const registerChart = useCallback(
    (chart: ECharts) => {
      if (chartsRef.current.includes(chart)) return;
      chartsRef.current.push(chart);

      chart.on('dataZoom', () => {
        syncZoom(chart);
      });

      // Activate drag-to-zoom by default after the toolbox feature is fully initialized.
      // A deferred dispatch is required because onChartReady fires synchronously
      // after setOption, before the toolbox dataZoom feature is ready to handle
      // the takeGlobalCursor action.
      requestAnimationFrame(() => {
        chart.dispatchAction({
          type: 'takeGlobalCursor',
          key: 'dataZoomSelect',
          dataZoomSelectActive: true,
        });
      });
    },
    [syncZoom]
  );

  // Show vertical line indicator when map replay progress changes
  useEffect(() => {
    if (!mapSyncEnabled || mapReplayProgress === 0) {
      // Clear axis pointer when not syncing or at start
      chartsRef.current.forEach((chart) => {
        chart.dispatchAction({
          type: 'hideTip',
        });
      });
      return;
    }

    const dataLength = data.time?.length ?? 0;
    if (dataLength === 0) return;

    const dataIndex = Math.round(mapReplayProgress * (dataLength - 1));

    chartsRef.current.forEach((chart) => {
      chart.dispatchAction({
        type: 'showTip',
        seriesIndex: 0,
        dataIndex,
      });
    });
  }, [mapSyncEnabled, mapReplayProgress, data.time]);

  // Memoize chart options to prevent unnecessary re-renders
  // Use dynamic chart creation when custom fields are selected
  const altitudeSpeedOption = useMemo(
    () => {
      const config = chartConfigs.altitudeSpeed;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitSystem,
          splitLineColor,
          tooltipFormatter,
          tooltipColors
        );
      }
      // Fallback to original chart when no fields selected
      return createAltitudeSpeedChart(
        data,
        unitSystem,
        splitLineColor,
        tooltipFormatter,
        tooltipColors
      );
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitSystem, chartConfigs.altitudeSpeed]
  );
  
  const batteryOption = useMemo(
    () => {
      const config = chartConfigs.battery;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitSystem,
          splitLineColor,
          tooltipFormatter,
          tooltipColors
        );
      }
      return createBatteryChart(data, splitLineColor, tooltipFormatter, tooltipColors);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitSystem, chartConfigs.battery]
  );
  
  const cellVoltageOption = useMemo(
    () => {
      const config = chartConfigs.cellVoltage;
      // If user selected custom fields, use dynamic chart
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitSystem,
          splitLineColor,
          tooltipFormatter,
          tooltipColors
        );
      }
      // Default: use the special cell voltage chart (shows individual cells)
      return createCellVoltageChart(data, splitLineColor, tooltipFormatter, tooltipColors);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitSystem, chartConfigs.cellVoltage]
  );
  
  const attitudeOption = useMemo(
    () => {
      const config = chartConfigs.attitude;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitSystem,
          splitLineColor,
          tooltipFormatter,
          tooltipColors
        );
      }
      return createAttitudeChart(data, splitLineColor, tooltipFormatter, tooltipColors);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitSystem, chartConfigs.attitude]
  );
  
  const rcSignalOption = useMemo(
    () => {
      const config = chartConfigs.rcSignal;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitSystem,
          splitLineColor,
          tooltipFormatter,
          tooltipColors
        );
      }
      return createRcSignalChart(data, splitLineColor, tooltipFormatter, tooltipColors);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitSystem, chartConfigs.rcSignal]
  );
  
  const distanceToHomeOption = useMemo(
    () => {
      const config = chartConfigs.distanceToHome;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitSystem,
          splitLineColor,
          tooltipFormatter,
          tooltipColors
        );
      }
      return createDistanceToHomeChart(data, unitSystem, splitLineColor, tooltipFormatter, tooltipColors);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitSystem, chartConfigs.distanceToHome]
  );
  
  const velocityOption = useMemo(
    () => {
      const config = chartConfigs.velocity;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitSystem,
          splitLineColor,
          tooltipFormatter,
          tooltipColors
        );
      }
      return createVelocityChart(data, unitSystem, splitLineColor, tooltipFormatter, tooltipColors);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitSystem, chartConfigs.velocity]
  );
  
  const gpsOption = useMemo(
    () => {
      const config = chartConfigs.gps;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitSystem,
          splitLineColor,
          tooltipFormatter,
          tooltipColors
        );
      }
      return createGpsChart(data, splitLineColor, tooltipFormatter, tooltipColors);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitSystem, chartConfigs.gps]
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-1.5">
        <button
          onClick={() => setMapSyncEnabled(!mapSyncEnabled)}
          className={`text-xs border rounded px-2 py-1 transition-colors ${
            mapSyncEnabled
              ? 'text-drone-accent border-drone-accent/50 bg-drone-accent/10'
              : 'text-gray-400 hover:text-white border-gray-700'
          }`}
          title={mapSyncEnabled ? 'Disable map sync' : 'Enable map sync'}
        >
          <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          Map sync
        </button>
        <button
          onClick={toggleDragZoom}
          className={`text-xs border rounded px-2 py-1 transition-colors ${
            dragZoomActive
              ? 'text-drone-primary border-drone-primary/50 bg-drone-primary/10'
              : 'text-gray-400 hover:text-white border-gray-700'
          }`}
          title={dragZoomActive ? 'Disable drag to zoom' : 'Enable drag to zoom'}
        >
          <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" viewBox="0 0 1024 1024" fill="currentColor">
            <path d="M1005.3 967.5L755.8 718.1c63.2-74.5 101.5-171 101.5-276.4C857.3 198 665.3 6 429.6 6S2 198 2 441.7s192 435.7 427.7 435.7c105.4 0 201.9-38.3 276.4-101.5l249.4 249.4c10.4 10.4 27.3 10.4 37.8 0l12-12c10.4-10.5 10.4-27.3 0-37.8zM429.6 810.4c-203.4 0-368.7-165.3-368.7-368.7s165.3-368.7 368.7-368.7 368.7 165.3 368.7 368.7-165.3 368.7-368.7 368.7z" />
          </svg>
          Drag zoom
        </button>
        <button
          onClick={resetZoom}
          className="text-xs text-gray-400 hover:text-white border border-gray-700 rounded px-2 py-1"
          title="Reset zoom on all charts"
        >
          Reset zoom
        </button>
        <button
          onClick={resetSelections}
          className="text-xs text-gray-400 hover:text-white border border-gray-700 rounded px-2 py-1"
          title="Reset all chart selections to default"
        >
          Reset selection
        </button>
      </div>

      {/* Altitude & Speed Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.altitudeSpeed}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('altitudeSpeed', { selectedFields: fields })}
          unitSystem={unitSystem}
          theme={resolvedTheme}
        />
        <div className="h-64">
          <ReactECharts
            option={altitudeSpeedOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>

      {/* Battery Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.battery}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('battery', { selectedFields: fields })}
          unitSystem={unitSystem}
          theme={resolvedTheme}
        />
        <div className="h-60">
          <ReactECharts
            option={batteryOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>

      {/* Cell Voltage Chart - only shown if cell voltage data exists */}
      {cellVoltageOption && (
        <div>
          <ChartHeader
            config={chartConfigs.cellVoltage}
            availableFields={TELEMETRY_FIELDS}
            onFieldsChange={(fields) => updateChartConfig('cellVoltage', { selectedFields: fields })}
            unitSystem={unitSystem}
            theme={resolvedTheme}
          />
          <div className="h-52">
            <ReactECharts
              option={cellVoltageOption}
              style={{ height: '100%', width: '100%' }}
              opts={{ renderer: 'canvas' }}
              notMerge={true}
              onChartReady={registerChart}
            />
          </div>
        </div>
      )}

      {/* Attitude Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.attitude}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('attitude', { selectedFields: fields })}
          unitSystem={unitSystem}
          theme={resolvedTheme}
        />
        <div className="h-64">
          <ReactECharts
            option={attitudeOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>

      {/* RC Signal Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.rcSignal}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('rcSignal', { selectedFields: fields })}
          unitSystem={unitSystem}
          theme={resolvedTheme}
        />
        <div className="h-40">
          <ReactECharts
            option={rcSignalOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>

      {/* Distance to Home Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.distanceToHome}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('distanceToHome', { selectedFields: fields })}
          unitSystem={unitSystem}
          theme={resolvedTheme}
        />
        <div className="h-52">
          <ReactECharts
            option={distanceToHomeOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>

      {/* Velocity Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.velocity}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('velocity', { selectedFields: fields })}
          unitSystem={unitSystem}
          theme={resolvedTheme}
        />
        <div className="h-52">
          <ReactECharts
            option={velocityOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>

      {/* GPS Satellites Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.gps}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('gps', { selectedFields: fields })}
          unitSystem={unitSystem}
          theme={resolvedTheme}
        />
        <div className="h-[207px]">
          <ReactECharts
            option={gpsOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>
    </div>
  );
}

/** Shared chart configuration - theme-aware */
function createBaseChartConfig(theme: 'dark' | 'light'): Partial<EChartsOption> {
  const isLight = theme === 'light';
  const axisColor = isLight ? '#cbd5e1' : '#4a4e69';
  const labelColor = isLight ? '#64748b' : '#9ca3af';
  const zoomBg = isLight ? '#f1f5f9' : '#16213e';
  const zoomBorder = isLight ? '#cbd5e1' : '#2a2a4e';
  const zoomFiller = isLight ? 'rgba(0, 122, 204, 0.15)' : 'rgba(0, 160, 220, 0.2)';
  const handleColor = isLight ? '#007acc' : '#00A0DC';

  return {
    animation: false,
    toolbox: {
      show: true,
      feature: {
        dataZoom: {
          yAxisIndex: 'none',
          title: { zoom: '', back: '' },
          iconStyle: { opacity: 0 },
          emphasis: { iconStyle: { opacity: 0 } },
        },
      },
      right: -999,
      top: -999,
      itemSize: 0,
    },
    grid: {
      left: 40,
      right: 40,
      top: 30,
      bottom: 50,
      containLabel: true,
    },
    tooltip: {
      trigger: 'axis',
      renderMode: 'html',
      appendToBody: true,
      extraCssText: 'z-index: 40;',
      backgroundColor: isLight ? '#ffffff' : '#16213e',
      borderColor: isLight ? '#e2e8f0' : '#4a4e69',
      textStyle: {
        color: isLight ? '#0f172a' : '#fff',
      },
      axisPointer: {
        type: 'line',
        axis: 'x',
        lineStyle: {
          color: axisColor,
        },
      },
    },
    legend: {
      textStyle: {
        color: labelColor,
      },
      top: 0,
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      axisLine: {
        lineStyle: {
          color: axisColor,
        },
      },
      axisLabel: {
        color: labelColor,
        formatter: (value: string) => {
          const secs = parseFloat(value);
          const mins = Math.floor(secs / 60);
          const remainingSecs = Math.floor(secs % 60);
          return `${mins}:${remainingSecs.toString().padStart(2, '0')}`;
        },
      },
      splitLine: {
        show: false,
      },
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'filter',
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseWheel: false,
        moveOnMouseMove: true,
        preventDefaultMouseMove: false,
      },
      {
        type: 'slider',
        xAxisIndex: 0,
        height: 18,
        bottom: 12,
        brushSelect: false,
        borderColor: zoomBorder,
        backgroundColor: zoomBg,
        fillerColor: zoomFiller,
        handleStyle: {
          color: handleColor,
        },
        textStyle: {
          color: labelColor,
        },
        dataBackground: {
          lineStyle: { color: isLight ? '#94a3b8' : '#4a4e69' },
          areaStyle: { color: isLight ? '#cbd5e1' : '#2a2a4e' },
        },
        selectedDataBackground: {
          lineStyle: { color: handleColor },
          areaStyle: { color: isLight ? 'rgba(0, 122, 204, 0.1)' : 'rgba(0, 160, 220, 0.15)' },
        },
      },
    ],
  };
}

// Module-level cache for current base config (set by TelemetryCharts component)
let baseChartConfig: Partial<EChartsOption> = createBaseChartConfig('dark');

function createAltitudeSpeedChart(
  data: TelemetryData,
  unitSystem: UnitSystem,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const hasHeight = data.height.some((val) => val !== null);
  const fallbackHeight = data.altitude ?? [];
  const heightSource = hasHeight ? data.height : fallbackHeight;
  const heightSeries =
    unitSystem === 'imperial'
      ? heightSource.map((val) => (val === null ? null : val * 3.28084))
      : heightSource;
  const vpsHeightSeries =
    unitSystem === 'imperial'
      ? data.vpsHeight.map((val) => (val === null ? null : val * 3.28084))
      : data.vpsHeight;
  const speedSeries =
    unitSystem === 'imperial'
      ? data.speed.map((val) => (val === null ? null : val * 2.236936))
      : data.speed.map((val) => (val === null ? null : val * 3.6));
  const heightUnit = unitSystem === 'imperial' ? 'ft' : 'm';
  const speedUnit = unitSystem === 'imperial' ? 'mph' : 'km/h';
  const heightRange = computeRange([
    ...heightSeries,
    ...vpsHeightSeries,
  ]);
  const speedRange = computeRange(speedSeries);

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: ['Height', 'VPS Height', 'Speed'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: [
      {
        type: 'value',
        name: `Height (${heightUnit})`,
        min: heightRange.min,
        max: heightRange.max,
        nameTextStyle: {
          color: '#00A0DC',
        },
        axisLine: {
          lineStyle: {
            color: '#00A0DC',
          },
        },
        axisLabel: {
          color: '#9ca3af',
        },
        splitLine: {
          lineStyle: {
            color: splitLineColor,
          },
        },
      },
      {
        type: 'value',
        name: `Speed (${speedUnit})`,
        min: speedRange.min,
        max: speedRange.max,
        nameTextStyle: {
          color: '#00D4AA',
        },
        axisLine: {
          lineStyle: {
            color: '#00D4AA',
          },
        },
        axisLabel: {
          color: '#9ca3af',
        },
        splitLine: {
          show: false,
        },
      },
    ],
    series: [
      {
        name: 'Height',
        type: 'line',
        data: heightSeries,
        yAxisIndex: 0,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#00A0DC',
        },
        lineStyle: {
          color: '#00A0DC',
          width: 2,
        },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(0, 160, 220, 0.3)' },
              { offset: 1, color: 'rgba(0, 160, 220, 0.05)' },
            ],
          },
        },
      },
      {
        name: 'VPS Height',
        type: 'line',
        data: vpsHeightSeries,
        yAxisIndex: 0,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#f97316',
        },
        lineStyle: {
          color: '#f97316',
          width: 1.5,
        },
      },
      {
        name: 'Speed',
        type: 'line',
        data: speedSeries,
        yAxisIndex: 1,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#00D4AA',
        },
        lineStyle: {
          color: '#00D4AA',
          width: 2,
        },
      },
    ],
  };
}

function createBatteryChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const batteryRange = computeRange(data.battery, { clampMin: 0, clampMax: 100 });
  const voltageRange = computeRange(data.batteryVoltage);
  const tempRange = computeRange(data.batteryTemp);
  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: ['Battery %', 'Voltage', 'Temperature'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: [
      {
        type: 'value',
        name: 'Battery %',
        min: batteryRange.min,
        max: batteryRange.max,
        axisLine: {
          lineStyle: {
            color: '#f59e0b',
          },
        },
        axisLabel: {
          color: '#9ca3af',
        },
        splitLine: {
          lineStyle: {
            color: splitLineColor,
          },
        },
      },
      {
        type: 'value',
        name: 'Temp (°C)',
        position: 'right',
        min: tempRange.min,
        max: tempRange.max,
        axisLine: {
          lineStyle: {
            color: '#a855f7',
          },
        },
        axisLabel: {
          color: '#9ca3af',
        },
        splitLine: {
          show: false,
        },
      },
      {
        type: 'value',
        position: 'right',
        offset: 44,
        min: voltageRange.min,
        max: voltageRange.max,
        axisLabel: {
          show: false,
        },
        axisLine: {
          show: false,
        },
        axisTick: {
          show: false,
        },
        splitLine: {
          show: false,
        },
      },
    ],
    series: [
      {
        name: 'Battery %',
        type: 'line',
        data: data.battery,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#f59e0b',
        },
        lineStyle: {
          color: '#f59e0b',
          width: 2,
        },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(245, 158, 11, 0.3)' },
              { offset: 1, color: 'rgba(245, 158, 11, 0.05)' },
            ],
          },
        },
        markArea: {
          silent: true,
          itemStyle: {
            color: 'rgba(239, 68, 68, 0.18)',
          },
          data: [[{ yAxis: 0 }, { yAxis: 20 }]],
        },
      },
      {
        name: 'Voltage',
        type: 'line',
        data: data.batteryVoltage,
        yAxisIndex: 2,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#38bdf8',
        },
        lineStyle: {
          color: '#38bdf8',
          width: 1.5,
        },
      },
      {
        name: 'Temperature',
        type: 'line',
        data: data.batteryTemp,
        yAxisIndex: 1,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#a855f7',
        },
        lineStyle: {
          color: '#a855f7',
          width: 1.5,
        },
      },
    ],
  };
}

// Colors for cell voltage series (up to 12 cells)
const cellVoltageColors = [
  '#10b981', // emerald-500
  '#3b82f6', // blue-500
  '#f59e0b', // amber-500
  '#ef4444', // red-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#14b8a6', // teal-500
  '#f97316', // orange-500
  '#6366f1', // indigo-500
  '#84cc16', // lime-500
  '#06b6d4', // cyan-500
  '#a855f7', // purple-500
];

function createCellVoltageChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption | null {
  // Determine the number of cells from the first non-null entry
  const cellVoltages = data.cellVoltages;
  if (!cellVoltages || cellVoltages.length === 0) {
    return null;
  }

  // Find first non-null entry to determine cell count
  const firstValidEntry = cellVoltages.find((v) => v !== null && v !== undefined);
  if (!firstValidEntry) {
    return null;
  }

  const numCells = firstValidEntry.length;
  if (numCells === 0) {
    return null;
  }

  // Extract individual cell series
  // Treat 0 values as missing (0.0 indicates unparsed/unavailable data)
  const cellSeries: (number | null)[][] = Array.from({ length: numCells }, () => []);
  for (const voltages of cellVoltages) {
    for (let i = 0; i < numCells; i++) {
      if (voltages && voltages[i] !== undefined && voltages[i] !== null && voltages[i] !== 0) {
        cellSeries[i].push(voltages[i]);
      } else {
        cellSeries[i].push(null);
      }
    }
  }

  // Compute range across all cells (excluding nulls which already excludes zeros)
  const allVoltages = cellSeries.flat().filter((v): v is number => v !== null);
  const voltageRange = computeRange(allVoltages, { paddingRatio: 0.05 });

  const legendData = Array.from({ length: numCells }, (_, i) => `Cell ${i + 1}`);

  const series: LineSeriesOption[] = cellSeries.map((values, i) => ({
    name: `Cell ${i + 1}`,
    type: 'line',
    data: values,
    smooth: true,
    symbol: 'none',
    itemStyle: {
      color: cellVoltageColors[i % cellVoltageColors.length],
    },
    lineStyle: {
      color: cellVoltageColors[i % cellVoltageColors.length],
      width: 1.5,
    },
  }));

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: legendData,
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: 'Cell Voltage (V)',
      min: voltageRange.min,
      max: voltageRange.max,
      axisLine: {
        lineStyle: {
          color: '#10b981',
        },
      },
      axisLabel: {
        color: '#9ca3af',
        formatter: '{value}',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series,
  };
}

function createAttitudeChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const attitudeRange = computeRange([
    ...data.pitch,
    ...data.roll,
    ...data.yaw,
  ]);
  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: ['Pitch', 'Roll', 'Yaw'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: 'Rotations',
      nameTextStyle: {
        color: '#8b5cf6',
      },
      min: attitudeRange.min,
      max: attitudeRange.max,
      axisLine: {
        lineStyle: {
          color: '#8b5cf6',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series: [
      {
        name: 'Pitch',
        type: 'line',
        data: data.pitch,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#8b5cf6',
        },
        lineStyle: {
          color: '#8b5cf6',
          width: 1.5,
        },
      },
      {
        name: 'Roll',
        type: 'line',
        data: data.roll,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#ec4899',
        },
        lineStyle: {
          color: '#ec4899',
          width: 1.5,
        },
      },
      {
        name: 'Yaw',
        type: 'line',
        data: data.yaw,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#14b8a6',
        },
        lineStyle: {
          color: '#14b8a6',
          width: 1.5,
        },
      },
    ],
  };
}

function createRcSignalChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const rcUplink = data.rcUplink ?? [];
  const rcDownlink = data.rcDownlink ?? [];
  const hasUplink = rcUplink.some((val) => val !== null && val !== undefined);
  const hasDownlink = rcDownlink.some((val) => val !== null && val !== undefined);
  const showCombined = !hasUplink && !hasDownlink;
  const series: LineSeriesOption[] = [
    ...(showCombined
      ? [
          {
            name: 'RC Signal',
            type: 'line' as const,
            data: data.rcSignal,
            smooth: true,
            symbol: 'none',
            itemStyle: {
              color: '#22c55e',
            },
            lineStyle: {
              color: '#22c55e',
              width: 1.5,
            },
          },
        ]
      : [
          {
            name: 'RC Uplink',
            type: 'line' as const,
            data: rcUplink,
            smooth: true,
            symbol: 'none',
            itemStyle: {
              color: '#22c55e',
            },
            lineStyle: {
              color: '#22c55e',
              width: 1.5,
            },
          },
          {
            name: 'RC Downlink',
            type: 'line' as const,
            data: rcDownlink,
            smooth: true,
            symbol: 'none',
            itemStyle: {
              color: '#38bdf8',
            },
            lineStyle: {
              color: '#38bdf8',
              width: 1.5,
            },
          },
        ]),
  ];
  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: showCombined ? ['RC Signal'] : ['RC Uplink', 'RC Downlink'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: 'RC Signal',
      min: 0,
      max: 100,
      interval: 50,
      axisLine: {
        lineStyle: {
          color: '#22c55e',
        },
      },
      axisLabel: {
        color: '#9ca3af',
        formatter: (value: number) => (value % 50 === 0 ? String(value) : ''),
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series,
  };
}

function createDistanceToHomeChart(
  data: TelemetryData,
  unitSystem: UnitSystem,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const distances = computeDistanceToHomeSeries(data);
  const distanceSeries =
    unitSystem === 'imperial'
      ? distances.map((val) => (val === null ? null : val * 3.28084))
      : distances;
  const distanceUnit = unitSystem === 'imperial' ? 'ft' : 'm';
  const distanceRange = computeRange(distanceSeries, { clampMin: 0 });

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: ['Distance to Home'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: `Distance (${distanceUnit})`,
      min: distanceRange.min,
      max: distanceRange.max,
      axisLine: {
        lineStyle: {
          color: '#22c55e',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series: [
      {
        name: 'Distance to Home',
        type: 'line',
        data: distanceSeries,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#22c55e',
        },
        lineStyle: {
          color: '#22c55e',
          width: 1.5,
        },
      },
    ],
  };
}

function createVelocityChart(
  data: TelemetryData,
  unitSystem: UnitSystem,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const velocityX = data.velocityX ?? [];
  const velocityY = data.velocityY ?? [];
  const velocityZ = data.velocityZ ?? [];
  const speedSeriesFactor = unitSystem === 'imperial' ? 2.236936 : 3.6;
  const xSeries = velocityX.map((val) => (val === null || val === undefined ? null : val * speedSeriesFactor));
  const ySeries = velocityY.map((val) => (val === null || val === undefined ? null : val * speedSeriesFactor));
  const zSeries = velocityZ.map((val) => (val === null || val === undefined ? null : val * speedSeriesFactor));
  const speedUnit = unitSystem === 'imperial' ? 'mph' : 'km/h';
  const speedRange = computeRange([...xSeries, ...ySeries, ...zSeries]);

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: ['X Speed', 'Y Speed', 'Z Speed'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: `Speed (${speedUnit})`,
      min: speedRange.min,
      max: speedRange.max,
      axisLine: {
        lineStyle: {
          color: '#f59e0b',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series: [
      {
        name: 'X Speed',
        type: 'line',
        data: xSeries,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#f59e0b',
        },
        lineStyle: {
          color: '#f59e0b',
          width: 1.5,
        },
      },
      {
        name: 'Y Speed',
        type: 'line',
        data: ySeries,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#ec4899',
        },
        lineStyle: {
          color: '#ec4899',
          width: 1.5,
        },
      },
      {
        name: 'Z Speed',
        type: 'line',
        data: zSeries,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#38bdf8',
        },
        lineStyle: {
          color: '#38bdf8',
          width: 1.5,
        },
      },
    ],
  };
}

function computeDistanceToHomeSeries(data: TelemetryData): Array<number | null> {
  const lats = data.latitude ?? [];
  const lngs = data.longitude ?? [];
  let homeLat: number | null = null;
  let homeLng: number | null = null;
  for (let i = 0; i < lats.length; i += 1) {
    const lat = lats[i];
    const lng = lngs[i];
    if (typeof lat === 'number' && typeof lng === 'number') {
      homeLat = lat;
      homeLng = lng;
      break;
    }
  }
  if (homeLat === null || homeLng === null) {
    return data.time.map(() => null);
  }

  return data.time.map((_, index) => {
    const lat = lats[index];
    const lng = lngs[index];
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    return haversineDistance(homeLat, homeLng, lat, lng);
  });
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

function createGpsChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const gpsRange = computeRange(data.satellites, { clampMin: 0 });
  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: ['GPS Satellites'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: 'Satellites',
      min: gpsRange.min,
      max: gpsRange.max,
      axisLine: {
        lineStyle: {
          color: '#0ea5e9',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series: [
      {
        name: 'GPS Satellites',
        type: 'line',
        data: data.satellites,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#0ea5e9',
        },
        lineStyle: {
          color: '#0ea5e9',
          width: 1.5,
        },
      },
    ],
  };
}

function computeRange(
  values: Array<number | null | undefined>,
  options: { clampMin?: number; clampMax?: number; paddingRatio?: number } = {}
): { min?: number; max?: number } {
  const cleaned = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );
  if (cleaned.length === 0) return {};

  let min = Math.min(...cleaned);
  let max = Math.max(...cleaned);
  if (min === max) {
    const delta = min === 0 ? 1 : Math.abs(min) * 0.1;
    min -= delta;
    max += delta;
  }

  const paddingRatio = options.paddingRatio ?? 0.08;
  const padding = (max - min) * paddingRatio;
  min -= padding;
  max += padding;

  if (typeof options.clampMin === 'number') {
    min = Math.max(min, options.clampMin);
  }
  if (typeof options.clampMax === 'number') {
    max = Math.min(max, options.clampMax);
  }

  min = roundAxisValue(min);
  max = roundAxisValue(max);

  if (min === max) {
    const bump = min === 0 ? 1 : Math.abs(min) * 0.1;
    min = roundAxisValue(min - bump);
    max = roundAxisValue(max + bump);
  }

  return { min, max };
}

function roundAxisValue(value: number): number {
  if (Math.abs(value) < 0.0001) return 0;
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return Number(value.toFixed(decimals));
}

function resolveThemeMode(mode: 'system' | 'dark' | 'light'): 'dark' | 'light' {
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

type TooltipFormatter = (params: any) => string;
type TooltipColors = {
  background: string;
  border: string;
  text: string;
};

function createTooltipFormatter(
  startTime: string | null,
  theme: 'light' | 'dark',
  locale?: string
): TooltipFormatter {
  return (params) => {
    const items = Array.isArray(params) ? params : [params];
    const axisValue = items[0]?.axisValue ?? '';
    const seconds =
      typeof axisValue === 'number'
        ? axisValue
        : Number.parseFloat(String(axisValue));
    const header = formatTooltipHeader(startTime, seconds, theme, locale);

    const lines = items.map((item) => {
      const marker = typeof item.marker === 'string' ? item.marker : '';
      const label = item.seriesName ?? '';
      const rawValue =
        Array.isArray(item.value) && item.value.length > 0
          ? item.value[item.value.length - 1]
          : item.value ?? item.data;
      const value =
        typeof rawValue === 'number' && Number.isFinite(rawValue)
          ? formatNumericValue(rawValue)
          : rawValue ?? '-';
      return `${marker} ${label}: ${value}`;
    });

    return [header, ...lines].join('<br/>');
  };
}

function formatTooltipHeader(
  startTime: string | null,
  seconds: number,
  theme: 'light' | 'dark',
  locale?: string
): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const durationLabel = formatDurationLabel(safeSeconds);
  if (!startTime) {
    return durationLabel;
  }
  const startDate = new Date(startTime);
  const timestamp = new Date(startDate.getTime() + safeSeconds * 1000);
  const timeLabel = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(timestamp);
  const durationBg = theme === 'light' ? 'rgba(15, 23, 42, 0.08)' : 'rgba(0,212,170,0.2)';
  const timeBg = theme === 'light' ? 'rgba(2, 132, 199, 0.12)' : 'rgba(0,160,220,0.22)';
  const textColor = theme === 'light' ? '#0f172a' : '#e2e8f0';
  return `<div style="margin-bottom:0px;display:flex;gap:6px;align-items:center;">
    <span class="tooltip-duration-tag" style="display:inline-block;padding:2px 8px;border-radius:999px;background:${durationBg};color:${textColor};font-size:11px;line-height:1.2;">${durationLabel}</span>
    <span class="tooltip-time-tag" style="display:inline-block;padding:2px 8px;border-radius:999px;background:${timeBg};color:${textColor};font-size:11px;line-height:1.2;">${timeLabel}</span>
  </div>`;
}

function formatDurationLabel(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(remaining).padStart(2, '0');
  return `${mm}m ${ss}s`;
}

function formatNumericValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/\.00$/, '');
}

function createTimeAxis(time: number[]): EChartsOption['xAxis'] {
  const values = time.map((t) => t.toFixed(1));
  return {
    type: 'category',
    boundaryGap: false,
    data: values,
    axisLine: {
      lineStyle: {
        color: '#4a4e69',
      },
    },
    axisTick: {
      alignWithLabel: true,
    } as any,
    axisLabel: {
      color: '#9ca3af',
      showMinLabel: false,
      showMaxLabel: false,
      hideOverlap: true,
      rotate: 30,
      interval: (index: number) => {
        if (index === 0) return true;
        const current = time[index];
        const previous = time[index - 1];
        if (!Number.isFinite(current) || !Number.isFinite(previous)) return false;
        return Math.floor(previous / 60) !== Math.floor(current / 60);
      },
      formatter: (value: string) => {
        return formatTimeLabel(value);
      },
    },
    splitLine: {
      show: false,
    },
  };
}

function formatTimeLabel(value: string): string {
  const secs = Number.parseFloat(value);
  if (!Number.isFinite(secs)) return '';
  const rounded = Math.round(secs);
  const mins = Math.floor(rounded / 60);
  const remainingSecs = Math.floor(rounded % 60);
  return `${mins}:${remainingSecs.toString().padStart(2, '0')}`;
}
