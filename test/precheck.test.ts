import test from 'node:test';
import assert from 'node:assert/strict';
import { precheckExperiment } from '../src/application/precheck-service.ts';
import { createServer } from '../src/http/server.ts';
import type { AnalysisRequest, CalibrationProfile, RawSample } from '../src/domain/types.ts';

function profile(overrides: Partial<CalibrationProfile> = {}): CalibrationProfile {
  return {
    profileId: 'cal-1', channelId: 'ch-a', validFromNs: 0,
    adcScale: 2, iOffset: 0, qOffset: 0, gainCorrection: 1, phaseCorrectionRad: 0,
    temperatureCoefficientPerK: 0, referenceTemperatureK: 0.02,
    systematicUncertainty: 0.01, sampleUncertainty: 0.001, ...overrides,
  };
}

function sample(index: number, overrides: Partial<RawSample> = {}): RawSample {
  return {
    captureId: `cap-${index}`, experimentId: 'exp-1', channelId: 'ch-a', role: 'readout-i',
    triggerId: `t-${Math.floor(index / 4)}`, timestampNs: index * 1_000_000,
    receivedAtNs: index * 1_000_000 + 100, sequence: index, sampleRateHz: 1_000,
    i: 0.3, q: 0.1, quality: 'good', ...overrides,
  };
}

function request(overrides: Partial<AnalysisRequest> = {}): AnalysisRequest {
  return {
    experimentId: 'exp-1', kind: 't1',
    samples: Array.from({ length: 8 }, (_, index) => sample(index)),
    calibrations: [profile()], ...overrides,
  };
}

test('precheck returns ready when calibration covers every sample', () => {
  const report = precheckExperiment(request());
  assert.equal(report.conclusion, 'ready');
  assert.equal(report.summary.errors, 0);
  assert.equal(report.summary.coveredSampleCount, 8);
  assert.equal(report.channels[0].startNs, 0);
  assert.equal(report.channels[0].endNs, 7_000_000);
});

test('precheck reports missing calibration by channel and time range', () => {
  const report = precheckExperiment(request({ calibrations: [profile({ validFromNs: 5_000_000 })] }));
  assert.equal(report.conclusion, 'fix-required');
  const finding = report.findings.find((item) => item.code === 'CALIBRATION_MISSING')!;
  assert.ok(finding);
  assert.equal(finding.channelId, 'ch-a');
  assert.equal(finding.startNs, 0);
  assert.equal(finding.endNs, 4_000_000);
  assert.equal(finding.sampleCount, 5);
});

test('precheck reports role mismatch when profile role disagrees with the sample', () => {
  const report = precheckExperiment(request({ calibrations: [profile({ role: 'flux' })] }));
  assert.equal(report.conclusion, 'fix-required');
  assert.ok(report.findings.some((finding) => finding.code === 'ROLE_MISMATCH' && finding.sampleCount === 8));
});

test('precheck treats overlapping profiles over samples as an error but ignores empty-range overlaps', () => {
  const overlap = request({
    calibrations: [
      profile({ profileId: 'cal-a', validFromNs: 0, validToNs: 6_000_000 }),
      profile({ profileId: 'cal-b', validFromNs: 3_000_000, validToNs: 9_000_000 }),
    ],
  });
  const report = precheckExperiment(overlap);
  assert.equal(report.conclusion, 'fix-required');
  const finding = report.findings.find((item) => item.code === 'CALIBRATION_OVERLAP')!;
  assert.equal(finding.profileIds.join(','), 'cal-a,cal-b');
  assert.equal(finding.startNs, 3_000_000);
  assert.equal(finding.sampleCount, 3);

  const emptyRange = precheckExperiment(request({
    calibrations: [
      profile({ profileId: 'cal-a', validFromNs: 0, validToNs: 1_000_000 }),
      profile({ profileId: 'cal-b', validFromNs: 1_000_000 }),
      profile({ profileId: 'cal-future', validFromNs: 100_000_000, validToNs: 200_000_000 }),
    ],
  }));
  assert.equal(emptyRange.conclusion, 'ready');
  assert.equal(emptyRange.findings.some((item) => item.code === 'CALIBRATION_OVERLAP'), false);
  assert.equal(emptyRange.channels[0].crossingBoundary, true);
});

test('precheck flags non-positive temperature correction as invalid', () => {
  const report = precheckExperiment(request({
    samples: Array.from({ length: 4 }, (_, index) => sample(index, { temperatureK: 1 })),
    calibrations: [profile({ temperatureCoefficientPerK: -2 })],
  }));
  assert.equal(report.conclusion, 'fix-required');
  assert.ok(report.findings.some((finding) => finding.code === 'INVALID_THERMAL_CORRECTION'));
});

test('precheck accepts missing sample temperature by falling back to the reference temperature', () => {
  const report = precheckExperiment(request({
    samples: Array.from({ length: 4 }, (_, index) => sample(index)),
    calibrations: [profile({ temperatureCoefficientPerK: 5 })],
  }));
  assert.equal(report.conclusion, 'ready');
  assert.equal(report.findings.length, 0);
});

test('precheck handles samples spanning multiple adjacent calibration intervals', () => {
  const report = precheckExperiment(request({
    calibrations: [
      profile({ profileId: 'cal-a', validFromNs: 0, validToNs: 4_000_000 }),
      profile({ profileId: 'cal-b', validFromNs: 4_000_000 }),
    ],
  }));
  assert.equal(report.conclusion, 'ready');
  const channel = report.channels.find((item) => item.channelId === 'ch-a')!;
  assert.equal(channel.crossingBoundary, true);
  assert.equal(channel.coveredSampleCount, 8);
});

test('precheck reports a mix of valid and invalid samples without discarding either', () => {
  const samples = Array.from({ length: 8 }, (_, index) => sample(index));
  samples[2] = { ...samples[2], quality: 'invalid' };
  samples[5] = { ...samples[5], i: Number.NaN };
  const report = precheckExperiment(request({ samples }));
  assert.equal(report.conclusion, 'fix-required');
  assert.equal(report.summary.validSampleCount, 6);
  assert.equal(report.summary.invalidSampleCount, 2);
  assert.equal(report.summary.coveredSampleCount, 6);
  const invalid = report.findings.filter((finding) => finding.code === 'INVALID_SAMPLE');
  assert.ok(invalid.some((finding) => finding.reason === 'quality-invalid'));
  assert.ok(invalid.some((finding) => finding.reason === 'iq'));
});

test('precheck deems fully invalid data unusable', () => {
  const allInvalid = request({ samples: [sample(0, { quality: 'invalid' }), sample(1, { quality: 'invalid' })] });
  assert.equal(precheckExperiment(allInvalid).conclusion, 'unusable');
  const empty = request({ samples: [] });
  assert.equal(precheckExperiment(empty).conclusion, 'unusable');
  const missingCalibration = request({
    samples: [sample(0)],
    calibrations: [profile({ channelId: 'other' })],
  });
  assert.equal(precheckExperiment(missingCalibration).conclusion, 'unusable');
});

test('precheck counts duplicate capture ids as dropped samples', () => {
  const first = sample(0);
  const second = sample(1);
  const report = precheckExperiment(request({ samples: [first, { ...first }, second, { ...second }] }));
  assert.equal(report.summary.duplicateSampleCount, 2);
  assert.equal(report.summary.evaluatedSampleCount, 2);
  assert.equal(report.conclusion, 'ready');

  const single = precheckExperiment(request({ samples: [first, { ...first }] }));
  assert.equal(single.summary.duplicateSampleCount, 1);
  assert.equal(single.conclusion, 'unusable');
});

test('precheck never mutates the request, samples or calibrations', () => {
  const body = request();
  const snapshot = JSON.stringify(body);
  precheckExperiment(body);
  assert.equal(JSON.stringify(body), snapshot);
  assert.deepEqual(body.samples[0], sample(0));
});

test('precheck treats an empty calibration table as missing coverage', () => {
  const report = precheckExperiment(request({ calibrations: [] }));
  assert.equal(report.conclusion, 'fix-required');
  assert.equal(report.findings.every((finding) => finding.code === 'CALIBRATION_MISSING'), true);
  assert.equal(report.summary.blockedSampleCount, 8);
});

test('precheck splits findings around covered rows and merges contiguous ones', () => {
  const report = precheckExperiment(request({
    calibrations: [profile({ validFromNs: 2_000_000, validToNs: 4_000_000 })],
  }));
  const missing = report.findings.filter((finding) => finding.code === 'CALIBRATION_MISSING');
  assert.equal(missing.length, 2);
  assert.deepEqual(missing.map((finding) => [finding.startNs, finding.endNs, finding.sampleCount]), [
    [0, 1_000_000, 2],
    [4_000_000, 7_000_000, 4],
  ]);
  assert.equal(report.channels[0].coveredSampleCount, 2);
});

test('precheck flags overlap against an open-ended calibration window', () => {
  const report = precheckExperiment(request({
    calibrations: [
      profile({ profileId: 'cal-a', validFromNs: 0, validToNs: 5_000_000 }),
      profile({ profileId: 'cal-b', validFromNs: 2_000_000 }),
    ],
  }));
  assert.equal(report.conclusion, 'fix-required');
  const finding = report.findings.find((item) => item.code === 'CALIBRATION_OVERLAP')!;
  assert.deepEqual(finding.profileIds, ['cal-a', 'cal-b']);
  assert.equal(finding.startNs, 2_000_000);
  assert.equal(finding.sampleCount, 3);
});

test('precheck treats conflicting capture payloads as invalid samples', () => {
  const first = sample(0);
  const report = precheckExperiment(request({ samples: [first, { ...first, i: 0.9 }, ...Array.from({ length: 4 }, (_, index) => sample(index + 1))] }));
  assert.equal(report.summary.invalidSampleCount, 1);
  assert.ok(report.findings.some((finding) => finding.code === 'INVALID_SAMPLE' && finding.reason === 'capture-conflict'));
  assert.equal(report.conclusion, 'fix-required');
});

test('precheck preserves findings separately for multiple channels', () => {
  const report = precheckExperiment(request({
    samples: [
      ...Array.from({ length: 4 }, (_, index) => sample(index)),
      ...Array.from({ length: 4 }, (_, index) => sample(index, { captureId: `cap-b-${index}`, channelId: 'ch-b' })),
    ],
    calibrations: [profile()],
  }));
  assert.equal(report.summary.channelCount, 2);
  const missing = report.findings.filter((finding) => finding.code === 'CALIBRATION_MISSING');
  assert.deepEqual([...new Set(missing.map((finding) => finding.channelId))], ['ch-b']);
  assert.equal(missing[0].startNs, 0);
  assert.equal(missing[0].endNs, 3_000_000);
  const channelB = report.channels.find((channel) => channel.channelId === 'ch-b')!;
  assert.equal(channelB.sampleCount, 4);
  assert.equal(channelB.coveredSampleCount, 0);
});

test('precheck HTTP surface reuses the shared error envelope for bad JSON and shape errors', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    const json = await fetch(`http://127.0.0.1:${port}/v1/experiments/precheck`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not-json' });
    assert.equal(json.status, 400);
    assert.equal((await json.json()).error.code, 'INVALID_JSON');

    const shape = await fetch(`http://127.0.0.1:${port}/v1/experiments/precheck`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request({ kind: 'bogus' as any })) });
    assert.equal(shape.status, 422);
    assert.equal((await shape.json()).error.code, 'INVALID_KIND');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('precheck returns errors through the standard HTTP envelope and a 200 report on success', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/v1/experiments/precheck`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(bad.status, 422);
    const badBody = await bad.json();
    assert.equal(badBody.error.code, 'INVALID_EXPERIMENT_ID');
    assert.equal(typeof badBody.error.message, 'string');

    const ok = await fetch(`http://127.0.0.1:${port}/v1/experiments/precheck`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()) });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.conclusion, 'ready');
    assert.equal(okBody.experimentId, 'exp-1');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
