import { z } from 'zod';
import { APPLICATION_STATUSES } from './status-machine.ts';

export const indeedJobIdSchema = z.string().min(1).max(128);

export const listingInputSchema = z.object({
  indeed_job_id: indeedJobIdSchema,
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().nullish(),
  apply_url: z.string().url(),
  description_md: z.string().nullish(),
  salary_min: z.number().int().nonnegative().nullish(),
  salary_max: z.number().int().nonnegative().nullish(),
  salary_currency: z.string().length(3).nullish(),
  job_type: z.string().nullish(),
  remote: z.boolean().nullish(),
  posted_at: z.coerce.date().nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const createSearchSchema = z.object({
  query: z.string().min(1),
  location: z.string().min(1),
  country_code: z.string().length(2),
  job_type: z.string().nullish(),
  raw_response: z.string().nullish(),
  listings: z.array(listingInputSchema).default([]),
});

export const updateListingSchema = listingInputSchema.partial().omit({ indeed_job_id: true });

export const createApplicationSchema = z.object({
  indeed_job_id: indeedJobIdSchema,
  fit_score: z.number().int().min(0).max(100).nullish(),
  fit_reasoning: z.string().nullish(),
  notes: z.string().nullish(),
});

export const createCoverLetterSchema = z.object({
  body_md: z.string().min(1),
});

export const updateStatusSchema = z.object({
  status: z.enum(APPLICATION_STATUSES),
  reason: z.string().nullish(),
});

export const createEventSchema = z.object({
  kind: z.enum([
    'pause_gate',
    'submitted',
    'response_received',
    'rejection',
    'offer',
    'note',
  ]),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const applicationsQuerySchema = z.object({
  status: z.enum(APPLICATION_STATUSES).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});
