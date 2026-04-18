// Captures the process start time once at module load.
// Import this wherever you need server uptime rather than re-declaring Date.now().
export const SERVER_START_TIME = Date.now();
