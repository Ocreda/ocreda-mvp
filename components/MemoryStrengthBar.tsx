'use client';

interface MemoryStrengthBarProps {
  score: number;
}

export function getMemoryColor(score: number): string {
  if (score <= 20) return '#ef4444';
  if (score <= 40) return '#f97316';
  if (score <= 60) return '#eab308';
  if (score <= 80) return '#86efac';
  return '#22c55e';
}

export default function MemoryStrengthBar({ score }: MemoryStrengthBarProps) {
  const clampedScore = Math.max(1, Math.min(100, score));
  const color = getMemoryColor(clampedScore);

  return (
    <div className="w-full h-0.5 bg-border rounded-full overflow-hidden mt-2">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${clampedScore}%`, backgroundColor: color }}
      />
    </div>
  );
}
