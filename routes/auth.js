/**
 * Checks if a user is authenticated. If not, redirects to the login page.
 */
function isAuthenticated(req, res, next) {
  if (req.session.user) {
    return next();
  }
  res.redirect('/login');
}

/**
 * Checks if a user is an administrator.
 */
function isAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  res.status(403).send('Access Denied: Administrator access required.');
}

module.exports = { isAuthenticated, isAdmin };