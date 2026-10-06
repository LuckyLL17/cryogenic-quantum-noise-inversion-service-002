import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.ts';
import { analyzeExperiment } from './analysis-service.ts';
import type { AnalysisRequest, AnalysisResult } from '../domain/types.ts';

type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
type Job = { id: string; state: JobState; request: AnalysisRequest; result?: AnalysisResult; error?: { code: string; message: string }; createdAt: string; startedAt?: string; finishedAt?: string };

const jobs = new Map<string, Job>();
const idempotency = new Map<string, string>();
const queue: string[] = [];
let draining = false;

function snapshot(job: Job): Omit<Job, 'request'> { const { request, ...safe } = job; return safe; }

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      const job = jobs.get(id);
      if (!job || job.state === 'cancelled') continue;
      job.state = 'running'; job.startedAt = new Date().toISOString();
      await new Promise<void>((resolve) => setImmediate(resolve));
      try { job.result = analyzeExperiment(job.request); job.state = 'completed'; }
      catch (error) { const domain = error instanceof DomainError ? error : new DomainError('ANALYSIS_FAILED', error instanceof Error ? error.message : 'Unknown analysis failure'); job.error = { code: domain.code, message: domain.message }; job.state = 'failed'; }
      job.finishedAt = new Date().toISOString();
    }
  } finally { draining = false; }
}

export function submit(request: AnalysisRequest, key?: string): { id: string; state: JobState } {
  if (key && idempotency.has(key)) { const id = idempotency.get(key)!; return { id, state: jobs.get(id)!.state }; }
  const job: Job = { id: randomUUID(), state: 'queued', request, createdAt: new Date().toISOString() };
  jobs.set(job.id, job); if (key) idempotency.set(key, job.id); queue.push(job.id); void drain(); return { id: job.id, state: job.state };
}

export function get(id: string): Omit<Job, 'request'> {
  const job = jobs.get(id);
  if (!job) throw new DomainError('JOB_NOT_FOUND', 'Analysis job was not found', 404, { id });
  return snapshot(job);
}

export function cancel(id: string): Omit<Job, 'request'> {
  const job = jobs.get(id);
  if (!job) throw new DomainError('JOB_NOT_FOUND', 'Analysis job was not found', 404, { id });
  if (job.state === 'queued') job.state = 'cancelled';
  else if (job.state === 'running') throw new DomainError('JOB_ALREADY_RUNNING', 'Running analysis cannot be cancelled after computation starts', 409, { id });
  return snapshot(job);
}
