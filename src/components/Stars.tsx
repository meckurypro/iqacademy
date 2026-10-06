// src/components/Stars.tsx — star ratings. <Stars> only shows a rating; <StarPicker> lets a student choose one.
import Icon from "./Icon";
import { cx } from "./ui";

export const RATING_WORDS = ["", "Poor", "Fair", "Good", "Very good", "Excellent"] as const;

export function Stars({ value, size = 16, className }: { value: number; size?: number; className?: string }) {
  return (
    <span role="img" aria-label={`${value} out of 5 stars`} className={cx("inline-flex items-center gap-0.5", className)}>
      {[1, 2, 3, 4, 5].map((n) => <Icon key={n} name="star" size={size} solid={n <= value} className={n <= value ? "text-accent" : "text-line"} />)}
    </span>
  );
}

export function StarPicker({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="space-y-2 text-center">
      <div role="radiogroup" aria-label="Rating" className="flex justify-center gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n === 1 ? "" : "s"}, ${RATING_WORDS[n]}`} onClick={() => onChange(n)}
            className="grid h-12 w-12 place-items-center rounded-full transition active:scale-90 hover:bg-sunken">
            <Icon name="star" size={34} solid={n <= value} className={cx("transition-colors", n <= value ? "text-accent" : "text-line")} />
          </button>))}
      </div>
      <p className={cx("h-5 text-sm font-medium transition-opacity", value ? "opacity-100" : "opacity-0")}>{RATING_WORDS[value] ?? ""}</p>
    </div>
  );
}
