import { useId, useState } from 'react';
import type { Traffic } from '../lib/types';
import { bytes } from '../lib/format';

export function TrafficChart({ data, mini = false }: { data: Traffic[]; mini?: boolean }) {
  const id = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const width = 800,
    height = mini ? 100 : 190,
    pad = mini ? 0 : 6;
  const samples =
    data.length > 1
      ? data
      : [
          { up: 0, down: 0 },
          { up: 0, down: 0 },
        ];
  const max = Math.max(1024, ...samples.flatMap((point) => [point.down, point.up])) * 1.2;
  const x = (index: number) => (index / (samples.length - 1)) * width;
  const y = (value: number) => height - pad - (value / max) * (height - pad * 2);
  const line = (key: 'up' | 'down') =>
    samples
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(point[key])}`)
      .join(' ');
  const point = hover === null ? undefined : samples[hover];
  return (
    <div className={`traffic-chart ${mini ? 'mini' : ''}`}>
      {!mini && (
        <div className="chart-y-labels">
          {[max, max * 0.66, max * 0.33, 0].map((value) => (
            <span key={value}>{bytes(value)}/s</span>
          ))}
        </div>
      )}
      <div
        className="chart-plot"
        onMouseMove={(event) => {
          if (mini) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setHover(
            Math.min(
              samples.length - 1,
              Math.max(
                0,
                Math.round(((event.clientX - rect.left) / rect.width) * (samples.length - 1)),
              ),
            ),
          );
        }}
        onMouseLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="最近 60 秒上传和下载速率曲线"
        >
          <defs>
            <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity=".18" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity=".01" />
            </linearGradient>
          </defs>
          {!mini &&
            [0, 1 / 3, 2 / 3, 1].map((v) => (
              <line
                key={v}
                x1="0"
                x2={width}
                y1={v * (height - pad * 2) + pad}
                y2={v * (height - pad * 2) + pad}
                stroke="var(--border)"
                strokeDasharray="4 6"
              />
            ))}
          <path
            d={`${line('down')} L ${width} ${height} L 0 ${height} Z`}
            fill={`url(#${id}-area)`}
          />
          <path
            d={line('down')}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2.4"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
          <path
            d={line('up')}
            fill="none"
            stroke="var(--green)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1="0"
              y2={height}
              stroke="var(--muted)"
              strokeDasharray="3 4"
            />
          )}
        </svg>
        {point && (
          <div
            className="chart-tooltip"
            style={{
              left: `${Math.min(76, Math.max(0, ((hover ?? 0) / (samples.length - 1)) * 100))}%`,
            }}
          >
            ↓ {bytes(point.down)}/s
            <br />↑ {bytes(point.up)}/s
          </div>
        )}
        {!mini && (
          <div className="chart-x-labels">
            <span>60 秒前</span>
            <span>45 秒</span>
            <span>30 秒</span>
            <span>15 秒</span>
            <span>现在</span>
          </div>
        )}
      </div>
    </div>
  );
}
