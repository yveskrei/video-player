// Per-class confidence thresholds for AI-analytics bbox filtering.
// `default` applies to any class not present in `overrides`.
// `overrides` keys are LOWERCASED class names — the resolver normalizes
// incoming class names the same way before lookup, making the match
// case-insensitive by construction. Values are on [0, 1].
export interface ConfidenceSettings {
    default: number;
    overrides: Record<string, number>;
}

export const DEFAULT_CONFIDENCE: ConfidenceSettings = {
    default: 0.5,
    overrides: {},
};

// Class-name comparison is done on the string form of whatever the backend
// sends — a numeric class ID like `12` and the literal "12" typed into the
// sub-menu input should match. Everything goes through String() first.
export const resolveConfidence = (
    className: string | number,
    settings: ConfidenceSettings,
): number => {
    const key = String(className).toLowerCase();
    const v = settings.overrides[key];
    return v !== undefined ? v : settings.default;
};

// Normalizes a class name for use as an override key. Coerces to string,
// trims whitespace, and lowercases. Returns `null` if the result is empty.
export const normalizeClassKey = (raw: string | number): string | null => {
    const trimmed = String(raw).trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : null;
};
