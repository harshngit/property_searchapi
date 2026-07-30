const authService = require('../services/auth.service');
const { success, error } = require('../utils/response');

// POST /api/admin/users/invite  (protected: admin, super_admin)
async function inviteUser(req, res, next) {
  try {
    const { fullName, email, role, tenantId } = req.body;

    const { invite, rawToken } = await authService.createInvite({
      inviterRole: req.user.role,
      inviterId: req.user.id,
      fullName,
      email,
      role,
      tenantId,
    });

    // In development, return the raw token for testing.
    // In production this must be removed - invite link is sent via email only.
    const debugToken = process.env.NODE_ENV !== 'production' ? { inviteToken: rawToken } : {};

    return success(res, 201, 'Invite sent successfully', { ...invite, role, ...debugToken });
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/users/invite/:token/verify  (public - lets frontend check validity before showing form)
async function verifyInvite(req, res, next) {
  try {
    const invite = await authService.getInviteByToken(req.params.token);
    if (!invite) return error(res, 400, 'Invite link is invalid or expired');

    return success(res, 200, 'Invite is valid', {
      fullName: invite.full_name,
      email: invite.email,
      role: invite.role_name,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/users/accept-invite  (public)
async function acceptInvite(req, res, next) {
  try {
    const { token, password } = req.body;
    const user = await authService.acceptInvite(token, password);
    return success(res, 201, 'Account created successfully. You can now login.', user);
  } catch (err) {
    next(err);
  }
}

module.exports = { inviteUser, verifyInvite, acceptInvite };
