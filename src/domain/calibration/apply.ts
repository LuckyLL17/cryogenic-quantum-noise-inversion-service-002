import { DomainError, invariant } from '../errors.ts';
import type { CalibrationProfile, RawSample, SynchronizedSample } from '../types.ts';

/** Profiles whose channel and validity window contain the sample, regardless of role. */
export function candidatesForSample(sample: RawSample, profiles: CalibrationProfile[]): CalibrationProfile[] {
  return profiles.filter((profile) => profile.channelId === sample.channelId && sample.timestampNs >= profile.validFromNs && (profile.validToNs === undefined || sample.timestampNs < profile.validToNs));
}

function roleMatches(profile: CalibrationProfile, sample: RawSample): boolean {
  return !profile.role || profile.role === sample.role;
}

/** Deterministic tie-break used when several profiles cover the same sample. */
export function pickProfile(profiles: CalibrationProfile[]): CalibrationProfile {
  return [...profiles].sort((a, b) => Number(Boolean(b.role)) - Number(Boolean(a.role)) || b.validFromNs - a.validFromNs || b.profileId.localeCompare(a.profileId))[0];
}

/** Thermal scale for a sample; missing sample temperature defaults to the profile reference. */
export function thermalScaleFor(sample: RawSample, profile: CalibrationProfile): number {
  const temperature = sample.temperatureK ?? profile.referenceTemperatureK;
  return 1 + profile.temperatureCoefficientPerK * (temperature - profile.referenceTemperatureK);
}

function chooseProfile(sample: RawSample, profiles: CalibrationProfile[]): CalibrationProfile {
  const matches = candidatesForSample(sample, profiles).filter((profile) => roleMatches(profile, sample));
  invariant(matches.length > 0, 'CALIBRATION_MISSING', 'No calibration profile covers sample', { captureId: sample.captureId, channelId: sample.channelId });
  return pickProfile(matches);
}

function validateProfile(profile: CalibrationProfile): void {
  invariant(Number.isFinite(profile.adcScale) && profile.adcScale > 0, 'INVALID_ADC_SCALE', 'ADC scale must be positive', { profileId: profile.profileId });
  invariant(Number.isFinite(profile.gainCorrection) && profile.gainCorrection > 0, 'INVALID_GAIN_CORRECTION', 'Gain correction must be positive', { profileId: profile.profileId });
  invariant(Number.isFinite(profile.systematicUncertainty) && profile.systematicUncertainty >= 0 && Number.isFinite(profile.sampleUncertainty) && profile.sampleUncertainty >= 0, 'INVALID_UNCERTAINTY', 'Calibration uncertainty must be non-negative', { profileId: profile.profileId });
  invariant(profile.referenceTemperatureK > 0, 'INVALID_REFERENCE_TEMPERATURE', 'Reference temperature must be positive', { profileId: profile.profileId });
}

export function applyCalibration(samples: RawSample[], profiles: CalibrationProfile[]): SynchronizedSample[] {
  invariant(Array.isArray(profiles) && profiles.length > 0, 'CALIBRATION_TABLE_EMPTY', 'Calibration profiles are required');
  const result: SynchronizedSample[] = [];
  samples.forEach((sample, index) => {
    const profile = chooseProfile(sample, profiles);
    validateProfile(profile);
    const thermalScale = thermalScaleFor(sample, profile);
    invariant(thermalScale > 0 && Number.isFinite(thermalScale), 'INVALID_THERMAL_SCALE', 'Temperature correction produced an invalid scale', { captureId: sample.captureId });
    const i0 = (sample.i - profile.iOffset) * profile.adcScale * thermalScale;
    const q0 = (sample.q - profile.qOffset) * profile.adcScale * thermalScale;
    const rotatedI = i0 * Math.cos(profile.phaseCorrectionRad) - q0 * Math.sin(profile.phaseCorrectionRad);
    const rotatedQ = i0 * Math.sin(profile.phaseCorrectionRad) + q0 * Math.cos(profile.phaseCorrectionRad);
    const calibratedI = rotatedI * profile.gainCorrection;
    const calibratedQ = rotatedQ * profile.gainCorrection;
    const amplitude = Math.hypot(calibratedI, calibratedQ);
    const phaseRad = Math.atan2(calibratedQ, calibratedI);
    const uncertainty = Math.hypot(profile.systematicUncertainty, profile.sampleUncertainty * Math.max(1, amplitude));
    if (![calibratedI, calibratedQ, amplitude, phaseRad, uncertainty].every(Number.isFinite)) throw new DomainError('CALIBRATION_OVERFLOW', 'Calibration output is not finite', 422, { captureId: sample.captureId });
    result.push({ ...sample, calibratedI, calibratedQ, amplitude, phaseRad, uncertainty, calibrationProfileId: profile.profileId, syncIndex: index });
  });
  return result;
}
