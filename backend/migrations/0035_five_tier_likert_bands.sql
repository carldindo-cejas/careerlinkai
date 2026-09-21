-- Migration 0035 — RIASEC and SCCT band on the five-tier item-mean scale
--
-- The system's interpretation changes, at the product owner's request, to the scale the approved
-- results exports (docs_report/) are printed on:
--
--   Item mean     Score          Label
--   1.00 - 1.79   20.0 - 35.9    Very Low
--   1.80 - 2.59   36.0 - 51.9    Low
--   2.60 - 3.39   52.0 - 67.9    Moderate
--   3.40 - 4.19   68.0 - 83.9    High
--   4.20 - 5.00   84.0 - 100.0   Very High
--
-- It replaces RIASEC's three tiers (Low/Moderate/High Interest at 34 and 67) and SCCT's four
-- (Low/Moderate/Moderately High/High at 34, 67 and 80). The nouns stay: "Very High Interest" for
-- a RIASEC dimension, "Very High Confidence" for an SCCT construct, and "Very High Career
-- Confidence." for the SCCT summary (section 55, migration 0028).
--
-- No score, Holland code, composite index or recommendation changes. Only the words attached to
-- numbers that already exist.
--
-- ## Unlike 0028, this rewrites delivered results — deliberately
--
-- 0028 renamed bands at unmoved thresholds and left stored labels alone. This migration moves the
-- thresholds, and the product owner chose to re-label every stored RIASEC/SCCT result from its own
-- stored score, so that the result screen, the counselor tables and the printed report all read
-- one scale. Leaving old rows alone would have shown "High Interest" at 70 on screen beside "High"
-- at 70 on paper for old students and a different cut at 68 for new ones.
--
-- ## Band order
--
-- Each JSON array is listed highest first with shared edges. The engine's interpret() takes the
-- first band containing the score, so 84 is Very High and 36 is Low, and a continuous composite
-- can never fall into a gap between two bands. The CASE expressions below use the same cut points
-- with >=, so a re-labelled row reads exactly as a freshly scored one would.
--
-- ## Scoping
--
-- Only the two globally-curated templates (category RIASEC / SCCT) and only their seeded dimension
-- codes. A counselor's CUSTOM instrument keeps whatever bands its author chose. Every statement is
-- a deterministic overwrite, so re-running is a no-op.

-- 1. RIASEC dimensions.
UPDATE assessment_dimensions
SET interpretation_ranges = '[{"min":84,"max":100,"label":"Very High Interest"},{"min":68,"max":84,"label":"High Interest"},{"min":52,"max":68,"label":"Moderate Interest"},{"min":36,"max":52,"label":"Low Interest"},{"min":0,"max":36,"label":"Very Low Interest"}]'
WHERE code IN ('R', 'I', 'A', 'S', 'E', 'C')
  AND assessment_template_id IN (SELECT id FROM assessment_templates WHERE category = 'RIASEC');

-- 2. SCCT constructs.
UPDATE assessment_dimensions
SET interpretation_ranges = '[{"min":84,"max":100,"label":"Very High Confidence"},{"min":68,"max":84,"label":"High Confidence"},{"min":52,"max":68,"label":"Moderate Confidence"},{"min":36,"max":52,"label":"Low Confidence"},{"min":0,"max":36,"label":"Very Low Confidence"}]'
WHERE code IN ('SE', 'OE', 'GO')
  AND assessment_template_id IN (SELECT id FROM assessment_templates WHERE category = 'SCCT');

-- 3. The SCCT composite bands, on every version's scoring_config. Weights and algorithm untouched.
UPDATE assessment_versions
SET scoring_config = json_set(
    scoring_config,
    '$.composite_ranges',
    json('[{"min":84,"max":100,"label":"Very High"},{"min":68,"max":84,"label":"High"},{"min":52,"max":68,"label":"Moderate"},{"min":36,"max":52,"label":"Low"},{"min":0,"max":36,"label":"Very Low"}]')
)
WHERE json_extract(scoring_config, '$.algorithm') = 'WEIGHTED_COMPOSITE'
  AND assessment_template_id IN (SELECT id FROM assessment_templates WHERE category = 'SCCT');

-- 4. Stored RIASEC dimension labels, re-banded from their own stored score.
UPDATE dimension_scores
SET interpretation = CASE
    WHEN normalized_score >= 84 THEN 'Very High Interest'
    WHEN normalized_score >= 68 THEN 'High Interest'
    WHEN normalized_score >= 52 THEN 'Moderate Interest'
    WHEN normalized_score >= 36 THEN 'Low Interest'
    ELSE 'Very Low Interest'
END
WHERE dimension_id IN (
    SELECT d.id
    FROM assessment_dimensions d
    JOIN assessment_templates t ON t.id = d.assessment_template_id
    WHERE t.category = 'RIASEC' AND d.code IN ('R', 'I', 'A', 'S', 'E', 'C')
);

-- 5. Stored SCCT construct labels.
UPDATE dimension_scores
SET interpretation = CASE
    WHEN normalized_score >= 84 THEN 'Very High Confidence'
    WHEN normalized_score >= 68 THEN 'High Confidence'
    WHEN normalized_score >= 52 THEN 'Moderate Confidence'
    WHEN normalized_score >= 36 THEN 'Low Confidence'
    ELSE 'Very Low Confidence'
END
WHERE dimension_id IN (
    SELECT d.id
    FROM assessment_dimensions d
    JOIN assessment_templates t ON t.id = d.assessment_template_id
    WHERE t.category = 'SCCT' AND d.code IN ('SE', 'OE', 'GO')
);

-- 6. Stored SCCT summaries. The index is recomputed the way lib/scoring.ts compositeIndex does it
--    and never parsed out of the old sentence (section 23): the weighted mean over constructs that
--    have a weight on the attempt's own version, renormalized, falling back to a plain mean when
--    no weight applies. Results with no construct scores keep their NULL summary, as the engine
--    would have written it.
UPDATE assessment_results
SET overall_summary = banded.label || ' Career Confidence.'
FROM (
    SELECT
        attempt_id,
        CASE
            WHEN idx >= 84 THEN 'Very High'
            WHEN idx >= 68 THEN 'High'
            WHEN idx >= 52 THEN 'Moderate'
            WHEN idx >= 36 THEN 'Low'
            ELSE 'Very Low'
        END AS label
    FROM (
        SELECT
            weighted.attempt_id,
            CASE
                WHEN SUM(weighted.weight) > 0
                    THEN SUM(weighted.score * weighted.weight) / SUM(weighted.weight)
                ELSE AVG(weighted.score)
            END AS idx
        FROM (
            SELECT
                ds.attempt_id AS attempt_id,
                ds.normalized_score AS score,
                json_extract(v.scoring_config, '$.composite_weights.' || d.code) AS weight
            FROM dimension_scores ds
            JOIN assessment_dimensions d ON d.id = ds.dimension_id
            JOIN assessment_attempts a ON a.id = ds.attempt_id
            JOIN assessment_versions v ON v.id = a.assessment_version_id
            JOIN assessment_templates t ON t.id = v.assessment_template_id
            WHERE t.category = 'SCCT'
              AND json_extract(v.scoring_config, '$.algorithm') = 'WEIGHTED_COMPOSITE'
        ) AS weighted
        GROUP BY weighted.attempt_id
    )
) AS banded
WHERE assessment_results.attempt_id = banded.attempt_id;
