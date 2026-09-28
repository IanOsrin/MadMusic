/**
 * lib/mixer-plans.js — which access codes open what (Mad Mixer front door, 2026-09-28).
 *
 *   Token_Type        MAD streaming   Mad Mixer
 *   (anything else)   yes             only with Audio_Lab_Enabled (the "can mix" flag)
 *   'mixer-trial'     NO              yes — one free split, after the email is confirmed
 *   'mixer'           NO              yes — the R99/month plan (Paystack, to come)
 *   'combined'        yes             yes — the R109.99/month plan (Paystack, to come)
 *
 * Mixer-only codes must never unlock streaming: server.js refuses them on every token-checked
 * /api route except /api/mixer/*, and /api/access/validate turns them away from MAD's sign-in.
 */
export const MIXER_ONLY_TYPES = new Set(['mixer', 'mixer-trial']);
export const MIXER_TYPES = new Set(['mixer', 'mixer-trial', 'combined']);
export const MIXER_TRIAL_TYPE = 'mixer-trial';
export const MIXER_TRIAL_SPLITS = 1;
export const MIXER_TRIAL_DAYS = 30;          // how long the free-split code stays usable

export const isMixerOnly = (type) => MIXER_ONLY_TYPES.has(String(type || ''));
export const isMixerPlan = (type) => MIXER_TYPES.has(String(type || ''));
