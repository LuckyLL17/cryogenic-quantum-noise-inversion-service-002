import { invariant } from '../domain/errors.ts';
import { candidatesForSample, pickProfile, thermalScaleFor } from '../domain/calibration/apply.ts';
import type {
  AnalysisRequest,
  CalibrationProfile,
  ChannelRole,
  ExperimentKind,
  PrecheckChannelReport,
  PrecheckConclusion,
  PrecheckFinding,
  PrecheckIssueCode,
  PrecheckReport,
  RawSample,
} from '../domain/types.ts';

const KNOWN_KINDS = new Set(['rabi', 'ramsey', 't1', 't2-echo', 'randomized-benchmarking', 'noise-only']);
const KNOWN_ROLES = new Set(['readout-i', 'readout-q', 'flux', 'drive-monitor', 'temperature']);
const EXAMPLE_LIMIT = 5;

// A sample that fails any of these checks cannot enter synchronization (and would
// therefore fail the analysis); the precheck never mutates the input to remove it.
function invalidReason(sample: any): string | null {
  if (!sample || typeof sample !== 'object') return 'malformed';
  if (!sample.captureId || typeof sample.captureId !== 'string') return 'identity';
  if (!sample.experimentId || typeof sample.experimentId !== 'string') return 'identity';
  if (!sample.channelId || typeof sample.channelId !== 'string') return 'identity';
  if (!sample.triggerId || typeof sample.triggerId !== 'string') return 'identity';
  if (!Number.isFinite(sample.timestampNs) || sample.timestampNs < 0) return 'timestamp';
  if (!Number.isFinite(sample.receivedAtNs) || sample.receivedAtNs < 0) return 'received-time';
  if (!Number.isInteger(sample.sequence) || sample.sequence < 0) return 'sequence';
  if (!Number.isFinite(sample.sampleRateHz) || sample.sampleRateHz <= 0) return 'sample-rate';
  if (!Number.isFinite(sample.i) || !Number.isFinite(sample.q)) return 'iq';
  if (sample.quality === 'invalid') return 'quality-invalid';
  if (sample.temperatureK !== undefined && !Number.isFinite(sample.temperatureK)) return 'temperature';
  if (sample.role !== undefined && (typeof sample.role !== 'string' || !KNOWN_ROLES.has(sample.role))) return 'role';
  return null;
}

function validCalibration(profile: any): profile is CalibrationProfile {
  return profile && typeof profile === 'object'
    && typeof profile.profileId === 'string' && profile.profileId.length > 0
    && typeof profile.channelId === 'string' && profile.channelId.length > 0
    && Number.isFinite(profile.validFromNs)
    && (profile.validToNs === undefined || (Number.isFinite(profile.validToNs) && profile.validToNs > profile.validFromNs));
}

function roleCompatible(a: CalibrationProfile, b: CalibrationProfile): boolean {
  return !a.role || !b.role || a.role === b.role;
}

function overlapStart(a: CalibrationProfile, b: CalibrationProfile): number {
  return Math.max(a.validFromNs, b.validFromNs);
}
function overlapEnd(a: CalibrationProfile, b: CalibrationProfile): number {
  return Math.min(a.validToNs ?? Number.POSITIVE_INFINITY, b.validToNs ?? Number.POSITIVE_INFINITY);
}

type Segment = {
  code: PrecheckIssueCode;
  reason: string;
  channelId: string;
  startNs: number;
  endNs: number;
  sampleCount: number;
  captures: string[];
  truncated: boolean;
};

/**
 * Read-only calibration/sample feasibility check. It performs every validation the
 * synchronization and calibration stages would (without spectrum or decay work),
 * reporting findings grouped by channel and contiguous time range. The request and
 * its samples/calibrations are never modified.
 */
export function precheckExperiment(request: AnalysisRequest): PrecheckReport {
  invariant(request && typeof request === 'object', 'INVALID_REQUEST', 'Analysis request body is required');
  invariant(typeof request.experimentId === 'string' && request.experimentId.length > 0, 'INVALID_EXPERIMENT_ID', 'Experiment id is required');
  invariant(Array.isArray(request.samples), 'INVALID_SAMPLES', 'Samples must be an array');
  invariant(Array.isArray(request.calibrations), 'INVALID_CALIBRATIONS', 'Calibrations must be an array');
  if (request.kind !== undefined) invariant(typeof request.kind === 'string' && KNOWN_KINDS.has(request.kind), 'INVALID_KIND', 'Unknown experiment kind', { kind: request.kind });

  // Findings merge into contiguous ranges in synchronized input order: same-key rows
  // merge while no unaffected row of the same channel sits between them, then split
  // at the healthy gap.
  const segments: Segment[] = [];
  const channelOrdinal = new Map<string, number>();
  const lastOrdinalByKey = new Map<string, number>();
  const nextOrdinal = (channelId: string): number => {
    const ordinal = channelOrdinal.get(channelId) ?? 0;
    channelOrdinal.set(channelId, ordinal + 1);
    return ordinal;
  };
  const addSampleFinding = (ordinal: number, channelId: string, captureId: string, timestampNs: number, code: PrecheckIssueCode, reason: string): void => {
    const ordinalKey = `${channelId}|${code}|${reason}`;
    const previousOrdinal = lastOrdinalByKey.get(ordinalKey);
    lastOrdinalByKey.set(ordinalKey, ordinal);
    // Extend the prior segment only when no unaffected row of the channel sits between.
    if (previousOrdinal !== undefined && ordinal - previousOrdinal === 1) {
      const existing = segments[segments.length - 1];
      if (existing && existing.channelId === channelId && existing.code === code && existing.reason === reason) {
        existing.endNs = Math.max(existing.endNs, timestampNs);
        existing.sampleCount += 1;
        if (existing.captures.length < EXAMPLE_LIMIT) existing.captures.push(captureId);
        else existing.truncated = true;
        return;
      }
    }
    segments.push({ code, reason, channelId, startNs: timestampNs, endNs: timestampNs, sampleCount: 1, captures: [captureId], truncated: false });
  };

  // Work on a copy: the request arrays and their elements must stay untouched.
  const ordered = [...request.samples].sort((a, b) => (Number.isFinite(a?.timestampNs) ? a.timestampNs : 0) - (Number.isFinite(b?.timestampNs) ? b.timestampNs : 0)
    || (Number(a?.sequence) || 0) - (Number(b?.sequence) || 0)
    || String(a?.captureId ?? '').localeCompare(String(b?.captureId ?? '')));

  // Mirror synchronizeSamples: exact repeated capture ids are dropped, conflicting
  // payloads under the same capture id are fatal to an analysis.
  const byCapture = new Map<string, RawSample>();
  let duplicateSampleCount = 0;
  let invalidSampleCount = 0;
  const validRows: RawSample[] = [];

  // Structurally broken calibration entries never cover anything; the samples they
  // should have covered surface as CALIBRATION_MISSING below.
  const profiles = request.calibrations.filter(validCalibration);

  const byChannel = new Map<string, RawSample[]>();
  const coveredByChannel = new Map<string, number>();
  const pickedProfilesByChannel = new Map<string, Set<string>>();
  let coveredSampleCount = 0;
  let blockedSampleCount = 0;

  ordered.forEach((row) => {
    const reason = invalidReason(row);
    if (reason) {
      invalidSampleCount += 1;
      const channelId = typeof row?.channelId === 'string' && row.channelId ? row.channelId : '(unknown)';
      addSampleFinding(
        nextOrdinal(channelId),
        channelId,
        typeof row?.captureId === 'string' && row.captureId ? row.captureId : '(unknown)',
        Number.isFinite(row?.timestampNs) ? row.timestampNs : 0,
        'INVALID_SAMPLE', reason,
      );
      return;
    }
    const sample = row as RawSample;
    const previous = byCapture.get(sample.captureId);
    if (previous) {
      const samePayload = previous.channelId === sample.channelId && previous.timestampNs === sample.timestampNs && previous.i === sample.i && previous.q === sample.q;
      if (samePayload) { duplicateSampleCount += 1; nextOrdinal(sample.channelId); return; }
      invalidSampleCount += 1;
      addSampleFinding(nextOrdinal(sample.channelId), sample.channelId, sample.captureId, sample.timestampNs, 'INVALID_SAMPLE', 'capture-conflict');
      return;
    }
    byCapture.set(sample.captureId, sample);
    validRows.push(sample);
    // Every surviving row consumes a per-channel ordinal so covered rows break the
    // contiguity of finding ranges around them.
    const ordinal = nextOrdinal(sample.channelId);
    const list = byChannel.get(sample.channelId) ?? [];
    list.push(sample);
    byChannel.set(sample.channelId, list);

    // Calibration coverage for rows that would survive synchronization.
    const candidates = candidatesForSample(sample, profiles);
    if (candidates.length === 0) {
      blockedSampleCount += 1;
      addSampleFinding(ordinal, sample.channelId, sample.captureId, sample.timestampNs, 'CALIBRATION_MISSING', 'no profile covers channel and time range');
      return;
    }
    // A role-bearing profile that disagrees with the sample cannot calibrate it;
    // profiles without a role restriction always match.
    if (candidates.some((entry) => entry.role && entry.role !== sample.role)) {
      blockedSampleCount += 1;
      addSampleFinding(ordinal, sample.channelId, sample.captureId, sample.timestampNs, 'ROLE_MISMATCH', `expected ${sample.role ?? 'unassigned'} role`);
      return;
    }
    const selected = pickProfile(candidates);
    const thermalScale = thermalScaleFor(sample, selected);
    if (!Number.isFinite(thermalScale) || thermalScale <= 0) {
      blockedSampleCount += 1;
      addSampleFinding(ordinal, sample.channelId, sample.captureId, sample.timestampNs, 'INVALID_THERMAL_CORRECTION', `thermal scale ${thermalScale} is not positive`);
      return;
    }
    coveredSampleCount += 1;
    coveredByChannel.set(sample.channelId, (coveredByChannel.get(sample.channelId) ?? 0) + 1);
    const picked = pickedProfilesByChannel.get(sample.channelId) ?? new Set<string>();
    picked.add(selected.profileId);
    pickedProfilesByChannel.set(sample.channelId, picked);
  });

  // Table-level validity overlap: role-compatible profiles of the same channel whose
  // windows intersect. Overlaps that actually contain submitted samples make the
  // calibration choice ambiguous; overlaps over empty ranges are not reported.
  const overlapFindings: PrecheckFinding[] = [];
  for (const channelId of [...new Set(profiles.map((entry) => entry.channelId))].sort()) {
    const channelProfiles = profiles.filter((entry) => entry.channelId === channelId);
    for (let i = 0; i < channelProfiles.length; i += 1) {
      for (let j = i + 1; j < channelProfiles.length; j += 1) {
        const a = channelProfiles[i];
        const b = channelProfiles[j];
        if (!roleCompatible(a, b)) continue;
        const start = overlapStart(a, b);
        const end = overlapEnd(a, b);
        if (!(start < end)) continue;
        const affected = (byChannel.get(channelId) ?? []).filter((sample) => sample.timestampNs >= start && (end === Number.POSITIVE_INFINITY || sample.timestampNs < end));
        if (affected.length === 0) continue;
        overlapFindings.push({
          code: 'CALIBRATION_OVERLAP',
          severity: 'error',
          channelId,
          startNs: start,
          endNs: end === Number.POSITIVE_INFINITY ? Math.max(...affected.map((sample) => sample.timestampNs)) : end,
          sampleCount: affected.length,
          reason: `calibration profiles ${a.profileId} and ${b.profileId} overlap over ${affected.length} sample(s)`,
          profileIds: [a.profileId, b.profileId].sort(),
          captureIds: affected.slice(0, EXAMPLE_LIMIT).map((sample) => sample.captureId),
          truncated: affected.length > EXAMPLE_LIMIT,
        });
      }
    }
  }

  const sampleFindings: PrecheckFinding[] = segments
    .slice()
    .sort((a, b) => a.channelId.localeCompare(b.channelId) || a.startNs - b.startNs || a.code.localeCompare(b.code))
    .map((segment) => ({
      code: segment.code,
      severity: 'error' as const,
      channelId: segment.channelId,
      startNs: segment.startNs,
      endNs: segment.endNs,
      sampleCount: segment.sampleCount,
      reason: segment.reason,
      profileIds: [] as string[],
      captureIds: segment.captures,
      truncated: segment.truncated,
    }));
  const allFindings = [...sampleFindings, ...overlapFindings.sort((a, b) => a.channelId.localeCompare(b.channelId) || a.startNs - b.startNs || a.reason.localeCompare(b.reason))];
  const findingByChannel = new Map<string, PrecheckFinding[]>();
  for (const finding of allFindings) findingByChannel.set(finding.channelId, [...(findingByChannel.get(finding.channelId) ?? []), finding]);

  // Channels are reported for any submitted channel, including ones whose samples are
  // all invalid (they still need a time range and a verdict in the response).
  const channelIds = new Set(byChannel.keys());
  for (const finding of sampleFindings) if (finding.code === 'INVALID_SAMPLE') channelIds.add(finding.channelId);

  const channels: PrecheckChannelReport[] = [];
  for (const channelId of [...channelIds].sort()) {
    const rows = byChannel.get(channelId) ?? [];
    const invalidFindings = (findingByChannel.get(channelId) ?? []).filter((finding) => finding.code === 'INVALID_SAMPLE');
    const channelInvalid = invalidFindings.reduce((sum, finding) => sum + finding.sampleCount, 0);
    const covered = coveredByChannel.get(channelId) ?? 0;
    const rangeRows: number[] = [
      ...rows.map((item) => item.timestampNs),
      ...invalidFindings.map((finding) => finding.startNs),
    ];
    channels.push({
      channelId,
      role: rows[0]?.role ?? null,
      startNs: rangeRows.length ? Math.min(...rangeRows) : 0,
      endNs: rangeRows.length ? Math.max(...rangeRows) : 0,
      sampleCount: rows.length + channelInvalid,
      invalidSampleCount: channelInvalid,
      coveredSampleCount: covered,
      usableSampleCount: covered,
      crossingBoundary: (pickedProfilesByChannel.get(channelId)?.size ?? 0) > 1,
      findings: (findingByChannel.get(channelId) ?? []).slice().sort((a, b) => a.startNs - b.startNs || a.code.localeCompare(b.code)),
    });
  }

  const errorCount = allFindings.filter((finding) => finding.severity === 'error').length;
  const warningCount = allFindings.filter((finding) => finding.severity === 'warning').length;
  // Raw data that survives synchronization and synchronization itself are fixable concerns:
  // invalid rows can be cleaned, the calibration table can be corrected. Only when no raw
  // sample would survive synchronization is there nothing worth submitting at all.
  let conclusion: PrecheckConclusion;
  if (validRows.length < 2) conclusion = 'unusable';
  else if (errorCount > 0) conclusion = 'fix-required';
  else conclusion = 'ready';

  const message = conclusion === 'ready'
    ? 'Calibration table covers the submitted samples; the analysis can be submitted as-is.'
    : conclusion === 'fix-required'
      ? 'Issues must be fixed before submitting the analysis.'
      : 'Not enough valid samples would survive synchronization; the submission should be abandoned.';

  return {
    experimentId: request.experimentId,
    kind: (request.kind as ExperimentKind | undefined) ?? null,
    conclusion,
    summary: {
      sampleCount: request.samples.length,
      validSampleCount: validRows.length,
      invalidSampleCount,
      duplicateSampleCount,
      channelCount: byChannel.size,
      evaluatedSampleCount: validRows.length,
      coveredSampleCount,
      blockedSampleCount,
      findings: allFindings.length,
      errors: errorCount,
      warnings: warningCount,
    },
    channels,
    findings: allFindings,
    message,
  };
}
