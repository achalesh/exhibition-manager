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

/**
 * Middleware to check if a user has one of the allowed roles.
 * Admins are always allowed.
 * @param {string[]} allowedRoles - An array of role strings that are allowed access.
 */
function hasRole(allowedRoles) {
  return (req, res, next) => {
    const user = req.session.user;

    if (!user) {
      return res.status(403).send('Access Denied.');
    }

    // Admin has access to everything
    if (user.role === 'admin' || allowedRoles.includes(user.role)) {
      return next();
    }

    return res.status(403).send('Access Denied: You do not have the required permissions.');
  };
}

module.exports = { isAuthenticated, isAdmin, hasRole };