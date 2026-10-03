/**
 * lib/mixer-plans.js — which access codes open what (Mad Mixer front door, 2026-09-28).
 *
 *   Token_Type        MAD streaming   Mad Mixer on its own home (MIXER_URL, Vercel)
 *   (anything else)   yes             NO — the Mixer offers the upgrade
 *   'mixer-trial'     NO              yes — one free split, after the email is confirmed
 *   'mixer'           NO              yes — the R99/month plan (Paystack, to come)
 *   'combined'        yes             yes — the R109.99/month plan (Paystack, to come)
 *
 * Mad Mixer access is decided by the PLAN alone (owner decision 2026-10-02): mixerEntitled()
 * below, used by the signed entitlement check (routes/mixer-internal.js). The old
 * Audio_Lab_Enabled flag grants nothing there — on 2026-10-02 no currently-valid code had it
 * (4 flagged codes, all expired since April/May 2026), so there is no transition rule; MAD no
 * longer reads the flag at all (removed with the old in-MAD Mixer, 2026-10-03).
 *
 * Mixer-only codes must never unlock streaming: server.js refuses them on every token-checked
 * /api route, and /api/access/validate turns them away from MAD's sign-in.
 */
export const MIXER_ONLY_TYPES = new Set(['mixer', 'mixer-trial']);
export const MIXER_TYPES = new Set(['mixer', 'mixer-trial', 'combined']);
export const MIXER_TRIAL_TYPE = 'mixer-trial';
export const MIXER_TRIAL_DAYS = 30;          // how long the free-split code stays usable

// Token_Type is often typed by hand in FileMaker ("Combined", "mixer "), so every check reads it
// trimmed and lower-cased.
export const planOf = (type) => String(type || '').trim().toLowerCase();
export const isMixerOnly = (type) => MIXER_ONLY_TYPES.has(planOf(type));
export const isMixerPlan = (type) => MIXER_TYPES.has(planOf(type));
export const isMixerTrial = (type) => planOf(type) === MIXER_TRIAL_TYPE;
/** May this code split in Mad Mixer? By plan only — see the table above. */
export const mixerEntitled = (type) => isMixerPlan(type);
