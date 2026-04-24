/**
 * lib/matching.js – Shared face matching utilities (pure math)
 *
 * Cosine-similarity based face descriptor matching. Used by both the service
 * worker (background.js) for cached fingerprint matching and the offscreen
 * document (offscreen.js) for live face detection matching.
 *
 * All functions are pure — no external dependencies (no Human.js, no DOM).
 * Results are equivalent to Human.match.similarity (which is also cosine sim).
 *
 * Techniques:
 *  1. Centroid matching — average descriptors per time period to reduce noise
 *  2. Top-K voting — consensus from top 5 closest descriptors
 *  3. Margin-based negative scoring — contrastive learning that penalises
 *     matches close to "not my child" profiles
 *  4. Adaptive threshold support — per-child threshold based on phase
 */

/**
 * Compute cosine similarity between two numeric vectors.
 * @param {number[]|Float32Array} a
 * @param {number[]|Float32Array} b
 * @returns {number} -1 to 1
 */
export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Compute similarity percentage (0–100) between two descriptors.
 * @param {number[]|Float32Array} a
 * @param {number[]|Float32Array} b
 * @returns {number} 0–100
 */
export function similarityPct(a, b) {
  const arrA = Array.isArray(a) ? a : Array.from(a);
  const arrB = Array.isArray(b) ? b : Array.from(b);
  return Math.max(0, Math.round(cosineSimilarity(arrA, arrB) * 100));
}

/**
 * Return the best match percentage (0–100) between an embedding and a
 * set of stored descriptors.
 *
 * @param {number[]|Float32Array} embedding
 * @param {number[][]}            descriptors
 * @returns {number}
 */
export function bestMatchPercent(embedding, descriptors) {
  if (!descriptors || descriptors.length === 0) return 0;
  let best = 0;
  for (const desc of descriptors) {
    const pct = similarityPct(embedding, desc);
    if (pct > best) best = pct;
  }
  return best;
}

/**
 * Compute centroid (element-wise average) of a list of descriptors.
 * Reduces noise from outlier photos by averaging multiple embeddings
 * into a single representative vector.
 *
 * @param {number[][]} descriptors
 * @returns {number[]|null}
 */
export function computeCentroid(descriptors) {
  if (!descriptors || descriptors.length === 0) return null;
  const dim = descriptors[0].length;
  const sum = new Float64Array(dim);
  for (const desc of descriptors) {
    for (let i = 0; i < dim; i++) sum[i] += desc[i];
  }
  const n = descriptors.length;
  return Array.from(sum, (v) => v / n);
}

/**
 * Build time-bucketed centroids from descriptors grouped by year.
 * Returns an array of centroid vectors (one per year bucket).
 *
 * @param {Object} descriptorsByYear  e.g. { "2025": [...], "2026": [...] }
 * @returns {number[][]}
 */
export function buildCentroids(descriptorsByYear) {
  if (!descriptorsByYear || typeof descriptorsByYear !== "object") return [];
  const centroids = [];
  for (const year of Object.keys(descriptorsByYear)) {
    const descs = descriptorsByYear[year];
    if (!Array.isArray(descs) || descs.length === 0) continue;
    const c = computeCentroid(descs);
    if (c) centroids.push(c);
  }
  return centroids;
}

/**
 * Top-K voting: check the K closest descriptors and return the fraction
 * that belong to the target child.  A high fraction means strong consensus.
 *
 * @param {number[]|Float32Array} embedding
 * @param {number[][]} descriptors  — target child's descriptors
 * @param {number[][]} negativeDescriptors — "not my child" descriptors
 * @param {number} [k=5] — number of nearest neighbours to consider
 * @returns {{ consensus: number, topKPositive: number, topKNegative: number }}
 */
export function topKVoting(embedding, descriptors, negativeDescriptors, k = 5) {
  const scored = [];
  for (const desc of descriptors) {
    scored.push({ pct: similarityPct(embedding, desc), type: "pos" });
  }
  for (const desc of negativeDescriptors) {
    scored.push({ pct: similarityPct(embedding, desc), type: "neg" });
  }
  scored.sort((a, b) => b.pct - a.pct);
  const topK = scored.slice(0, k);
  if (topK.length === 0) return { consensus: 0, topKPositive: 0, topKNegative: 0 };
  const posCount = topK.filter((s) => s.type === "pos").length;
  const negCount = topK.filter((s) => s.type === "neg").length;
  return {
    consensus:    posCount / topK.length,
    topKPositive: posCount,
    topKNegative: negCount,
  };
}

/**
 * Enhanced face matching: combines centroid matching, individual descriptor
 * matching, top-K voting, and margin-based negative scoring.
 *
 * Returns an effective score (0–100) that accounts for all factors.
 *
 * @param {number[]} embedding — face embedding to evaluate
 * @param {number[][]} positiveDescriptors — target child's descriptors
 * @param {number[][]} negativeDescriptors — "not my child" descriptors
 * @param {number[][]} centroids — pre-computed centroid vectors
 * @returns {{ effectiveScore: number, rawPositive: number, rawNegative: number,
 *             centroidScore: number, consensus: number, margin: number }}
 */
export function enhancedMatch(embedding, positiveDescriptors, negativeDescriptors, centroids) {
  // 1. Raw positive match (best individual descriptor)
  const rawPositive = bestMatchPercent(embedding, positiveDescriptors);

  // 2. Centroid match (more stable, less noisy)
  const centroidScore = centroids.length > 0
    ? bestMatchPercent(embedding, centroids)
    : rawPositive;

  // 3. Raw negative match
  const rawNegative = bestMatchPercent(embedding, negativeDescriptors);

  // 4. Top-K voting (consensus among nearest neighbours)
  const { consensus } = (positiveDescriptors.length + negativeDescriptors.length >= 5)
    ? topKVoting(embedding, positiveDescriptors, negativeDescriptors, 5)
    : { consensus: 1.0 };

  // 5. Margin-based negative penalty
  const NEGATIVE_WEIGHT = 0.6;
  const negativePenalty = rawNegative > 0 ? rawNegative * NEGATIVE_WEIGHT : 0;

  // 6. Consensus penalty
  const consensusFactor = 0.5 + (consensus * 0.5);

  // 7. Combine: use the better of raw and centroid, apply penalties
  const baseScore = Math.max(rawPositive, centroidScore);
  const margin = baseScore - negativePenalty;
  const effectiveScore = Math.max(0, Math.round(margin * consensusFactor));

  return { effectiveScore, rawPositive, rawNegative, centroidScore, consensus, margin };
}
