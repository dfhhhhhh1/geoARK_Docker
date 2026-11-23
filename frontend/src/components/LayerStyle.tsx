import React from 'react';
import type { Ramp } from '../lib/basemaps';

/** Colour ramp swatches and an opacity slider, one row: the style of one map layer. */
export const LayerStyle: React.FC<{
  ramps: Ramp[];
  rampId: string;
  dark?: boolean;
  opacity: number;
  onRamp: (id: string) => void;
  onOpacity: (v: number) => void;
  label: string;
}> = ({ ramps, rampId, dark = false, opacity, onRamp, onOpacity, label }) => (
  <div className="flex items-center gap-2">
    <div className="flex gap-1" role="radiogroup" aria-label={`${label} colours`}>
      {ramps.map(r => {
        const c = dark ? r.dark : r.light;
        return (
          <button key={r.id} type="button" role="radio" aria-checked={r.id === rampId} title={r.label}
                  onClick={() => onRamp(r.id)}
                  className={`h-4 w-7 rounded-sm overflow-hidden ring-offset-1 ${
                    r.id === rampId ? 'ring-2 ring-ink' : 'ring-1 ring-slate-300 hover:ring-slate-500'}`}
                  style={{ background: `linear-gradient(90deg, ${c.join(', ')})` }} />
        );
      })}
    </div>
    <input type="range" min={0.15} max={1} step={0.05} value={opacity}
           onChange={e => onOpacity(Number(e.target.value))}
           className="flex-1 min-w-0 accent-ink cursor-pointer" aria-label={`${label} opacity`}
           title={`Opacity ${Math.round(opacity * 100)}%`} />
  </div>
);

/** A colour bar with its break values under it. */
export const RampLegend: React.FC<{ colors: string[]; edges: number[]; unit?: string; fmt: (v: number) => string }> =
  ({ colors, edges, unit, fmt }) => (
    <div>
      <div className="flex h-2.5 rounded overflow-hidden">
        {colors.slice(0, Math.max(1, edges.length - 1)).map((c, i) => (
          <div key={i} className="flex-1" style={{ background: c }} />
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-slate-600 mt-0.5 tabular-nums">
        {edges.map((e, i) => <span key={i}>{fmt(e)}</span>)}
      </div>
      {unit && <div className="text-[11px] text-slate-500 leading-tight">{unit}</div>}
    </div>
  );
