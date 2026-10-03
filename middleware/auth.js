function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.status(401).json({ error: 'Admin login required' });
}

function requireCrew(req, res, next) {
  if (req.session && req.session.crewId) return next();
  return res.status(401).json({ error: 'Crew login required' });
}

module.exports = { requireAdmin, requireCrew };
