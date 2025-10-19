const { get, all } = require('./db-helpers');

/**
 * Middleware to identify the active event session and make it available
 * to all subsequent routes and views.
 */
async function sessionHandler(req, res, next) {
  try {
    // 1. Find the currently active session (for data entry). Fallback to the first one if none are active.
    let activeSession = await get('SELECT * FROM event_sessions WHERE is_active = 1');
    if (!activeSession) {
      activeSession = await get('SELECT * FROM event_sessions ORDER BY id LIMIT 1');
    }

    // 2. Determine which session to VIEW based on the query parameter.
    const viewSessionId = req.query.view_session_id;
    let viewingSession;

    if (viewSessionId && viewSessionId !== 'active') {
      // If a specific session ID is requested, fetch it.
      viewingSession = await get('SELECT * FROM event_sessions WHERE id = ?', [viewSessionId]);
    }

    // If no view session is specified, if it's invalid, or if 'active' is chosen, default to the active session.
    if (!viewingSession) {
      viewingSession = activeSession;
    }

    // 3. Fetch all sessions for the dropdown switcher in the UI.
    const allSessions = await all('SELECT * FROM event_sessions ORDER BY is_active DESC, start_date DESC, name');

    // 4. Make session data available globally in res.locals
    res.locals.activeSession = activeSession; // The session for writing new data.
    res.locals.viewingSession = viewingSession; // The session for reading/displaying data.
    res.locals.allSessions = allSessions;

    next();
  } catch (err) {
    console.error("FATAL: Could not determine active event session.", err);
    // This is a critical error, so we stop the request.
    res.status(500).send("Error: Could not determine active event session. Please configure one in the admin panel.");
  }
}

module.exports = sessionHandler;