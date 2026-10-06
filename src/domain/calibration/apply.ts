import { DomainError, invariant } from '../errors.ts';
import type { CalibrationProfile, RawSample, SynchronizedSample } from '../types.ts';

function covers(profile: CalibrationProfile, sample: RawSample): boolean {
  return profile.channelId === sample.channelId && sample.timestampNs >= profile.validFromNs && (profile.validToNs === undefined || sample.timestampNs < profile.validToNs) && (!profile.role || profile.role === sample.role);
}

function chooseProfile(sample: RawSample, profiles: CalibrationProfile[]): CalibrationProfile {
  const matches = profiles.filter((profile) => covers(profile, sample));
  invariant(matches.length > 0, 'CALIBRATION_MISSING', 'No calibration profile covers sample', { captureId: sample.captureId, channelId: sample.channelId });
  return [...matches].sort((a, b) => Number(Boolean(b.role)) - Number(Boolean(a.role)) || b.validFromNs - a.validFromNs || b.profileId.localeCompare(a.profileId))[0];
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
    const temperature = sample.temperatureK ?? profile.referenceTemperatureK;
    const thermalScale = 1 + profile.temperatureCoefficientPerK * (temperature - profile.referenceTemperatureK);
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
