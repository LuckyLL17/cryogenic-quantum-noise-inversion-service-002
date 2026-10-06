import { invariant } from '../errors.ts';
import type { CrossSpectrumBin, SpectrumBin, WindowedSeries } from '../types.ts';

function dft(values: number[]): { real: number; imag: number }[] {
  const n = values.length;
  return Array.from({ length: Math.floor(n / 2) + 1 }, (_, k) => {
    let real = 0;
    let imag = 0;
    for (let index = 0; index < n; index += 1) {
      const angle = (2 * Math.PI * k * index) / n;
      real += values[index] * Math.cos(angle);
      imag -= values[index] * Math.sin(angle);
    }
    return { real, imag };
  });
}

function averageBins(bins: SpectrumBin[][]): SpectrumBin[] {
  if (!bins.length) return [];
  return bins[0].map((_, index) => ({ frequencyHz: bins[0][index].frequencyHz, power: bins.reduce((sum, bin) => sum + bin[index].power, 0) / bins.length, amplitude: bins.reduce((sum, bin) => sum + bin[index].amplitude, 0) / bins.length }));
}

export function periodogram(windows: WindowedSeries[], maxFrequencyHz = Number.POSITIVE_INFINITY): SpectrumBin[] {
  invariant(windows.length > 0, 'EMPTY_WINDOWS', 'At least one analysis window is required');
  const perWindow = windows.map((window) => {
    const transformed = dft(window.values);
    const normalization = window.sampleRateHz * window.values.length;
    return transformed.map((value, index) => {
      const frequencyHz = (index * window.sampleRateHz) / window.values.length;
      const power = (value.real ** 2 + value.imag ** 2) / Math.max(normalization, 1);
      return { frequencyHz, power, amplitude: Math.sqrt(power) };
    }).filter((bin) => bin.frequencyHz <= maxFrequencyHz);
  });
  return averageBins(perWindow);
}

export function crossSpectrum(left: WindowedSeries[], right: WindowedSeries[], maxFrequencyHz = Number.POSITIVE_INFINITY): CrossSpectrumBin[] {
  invariant(left.length === right.length && left.length > 0, 'CROSS_WINDOW_MISMATCH', 'Cross-spectrum requires paired windows');
  const spectra = left.map((leftWindow, windowIndex) => {
    const a = dft(leftWindow.values);
    const b = dft(right[windowIndex].values);
    const n = Math.min(a.length, b.length);
    return Array.from({ length: n }, (_, index) => {
      const crossReal = a[index].real * b[index].real + a[index].imag * b[index].imag;
      const crossImag = a[index].imag * b[index].real - a[index].real * b[index].imag;
      const leftPower = a[index].real ** 2 + a[index].imag ** 2;
      const rightPower = b[index].real ** 2 + b[index].imag ** 2;
      const coherence = leftPower && rightPower ? Math.min(1, (crossReal ** 2 + crossImag ** 2) / (leftPower * rightPower)) : 0;
      const frequencyHz = (index * leftWindow.sampleRateHz) / leftWindow.values.length;
      return { frequencyHz, power: Math.hypot(crossReal, crossImag) / Math.max(leftWindow.sampleRateHz * leftWindow.values.length, 1), amplitude: Math.sqrt(Math.hypot(crossReal, crossImag)), coherence, phaseRad: Math.atan2(crossImag, crossReal) };
    }).filter((bin) => bin.frequencyHz <= maxFrequencyHz);
  });
  return spectra[0].map((_, index) => ({ frequencyHz: spectra[0][index].frequencyHz, power: spectra.reduce((sum, item) => sum + item[index].power, 0) / spectra.length, amplitude: spectra.reduce((sum, item) => sum + item[index].amplitude, 0) / spectra.length, coherence: spectra.reduce((sum, item) => sum + item[index].coherence, 0) / spectra.length, phaseRad: Math.atan2(spectra.reduce((sum, item) => sum + Math.sin(item[index].phaseRad), 0), spectra.reduce((sum, item) => sum + Math.cos(item[index].phaseRad), 0)) }));
}
