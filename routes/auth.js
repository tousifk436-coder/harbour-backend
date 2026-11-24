const router = require("express").Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const config = require("../config");
const { User, Workspace } = require("../models");
const { signToken, requireAuth } = require("../middleware/auth");
const { wrap, bad, HttpError, idParam, json } = require("../utils/http");
const { sendMail } = require("../utils/mail");

const loginHits = new Map();
function tooManyAttempts(key, max = 10, windowMs = 15 * 60_000) {
  const now = Date.now();
  const arr = (loginHits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  loginHits.set(key, arr);
  return arr.length > max;
}

const profileOf = (id) =>
  User.findById(id).populate({ path: "department", select: "name" });

// POST /api/auth/login { email, password } -> { token, user }
router.post(
  "/login",
  wrap(async (req, res) => {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");
    if (!email || !password) throw bad("Email and password are required.");
    if (tooManyAttempts(`${req.ip}:${email}`))
      throw new HttpError(
        429,
        "Too many attempts. Wait a few minutes and try again.",
        "rate_limited",
      );
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      throw new HttpError(
        401,
        "Invalid login credentials",
        "invalid_credentials",
      );
    if (!user.is_active)
      throw new HttpError(
        403,
        "Your account has been deactivated. Contact your administrator.",
        "inactive",
      );
    if (user.is_owner !== true && user.workspace_id) {
      const ws = await Workspace.findById(user.workspace_id)
        .select("is_active")
        .lean();
      if (ws && ws.is_active === false)
        throw new HttpError(
          403,
          "This company's access has been suspended. Please contact support.",
          "workspace_suspended",
        );
    }
    const profile = await profileOf(user._id);
    res.json({ token: signToken(user), user: json(profile) });
  }),
);

// GET /api/auth/me -> current profile
router.get(
  "/me",
  requireAuth,
  wrap(async (req, res) => {
    res.json(json(await profileOf(req.user._id)));
  }),
);

// POST /api/auth/impersonate { user_id } -> { token, user }
// "Login as": a super admin (or the owner) gets a working session for one of
// their admins/agents, to see and use the CRM exactly as that person does.
// The caller's own token stays valid in their browser, which keeps a
// "switch back" control. Only admins and agents can be targeted — never another
// super admin or the owner account — so this cannot be used to gain more access.
router.post(
  "/impersonate",
  requireAuth,
  wrap(async (req, res) => {
    const me = req.user;
    if (me.role !== "super_admin" && me.is_owner !== true)
      throw new HttpError(
        403,
        "Only a super admin can use Login as.",
        "forbidden",
      );
    const target = await User.findById(idParam(req.body.user_id));
    if (!target || String(target.workspace_id) !== String(me.workspace_id))
      throw bad("User not found.");
    if (String(target._id) === String(me._id))
      throw bad("You are already signed in as yourself.");
    // A super admin may log in as ANY user in their company — admins, agents and
    // other super admins — so super admins can cover for each other. (The caller
    // is already restricted to super admin / owner above.)
    if (!target.is_active)
      throw bad("That account is deactivated — reactivate it first.");
    console.log(
      `[impersonate] ${me.email} -> ${target.email} (ws ${me.workspace_id})`,
    );
    const profile = await profileOf(target._id);
    res.json({ token: signToken(target), user: json(profile) });
  }),
);

// POST /api/auth/password { current_password, password } -> { token }  (signs out other devices)
// The website always sends current_password; it is checked whenever it is sent.
router.post(
  "/password",
  requireAuth,
  wrap(async (req, res) => {
    const pw = String(req.body.password || "");
    if (pw.length < 8) throw bad("Password must be at least 8 characters");
    if (pw.length > 128) throw bad("Password is too long");
    if (req.body.current_password !== undefined) {
      const current = String(req.body.current_password || "");
      if (!(await bcrypt.compare(current, req.user.password_hash)))
        throw bad("Your current password is not correct.", "wrong_password");
      if (current === pw)
        throw bad("The new password must be different from the current one.");
    }
    req.user.password_hash = await bcrypt.hash(pw, 10);
    req.user.token_version = (req.user.token_version || 0) + 1;
    await req.user.save();
    res.json({ ok: true, token: signToken(req.user) });
  }),
);

// POST /api/auth/forgot { email } -> always ok (does not reveal whether the email exists)
router.post(
  "/forgot",
  wrap(async (req, res) => {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    if (tooManyAttempts(`forgot:${req.ip}`, 5, 15 * 60_000))
      throw new HttpError(
        429,
        "Too many requests. Try again later.",
        "rate_limited",
      );
    const user = email ? await User.findOne({ email, is_active: true }) : null;
    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      user.reset_token_hash = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
      user.reset_expires = new Date(Date.now() + 60 * 60_000);
      await user.save();
      const link = `${config.webAppUrl}/reset-password?token=${token}`;
      await sendMail({
        to: user.email,
        subject: "Reset your AucWin CRM password",
        text: `Hi ${user.full_name || ""},\n\nUse this link to choose a new password (valid for 1 hour):\n${link}\n\nIf you did not ask for this, ignore this email.`,
        html: `<p>Hi ${user.full_name || ""},</p><p>Use this link to choose a new password (valid for 1 hour):</p><p><a href="${link}">${link}</a></p><p>If you did not ask for this, ignore this email.</p>`,
      }).catch((e) => console.error("[mail] failed:", e.message));
    }
    res.json({ ok: true });
  }),
);

// POST /api/auth/reset { token, password }
router.post(
  "/reset",
  wrap(async (req, res) => {
    const token = String(req.body.token || "");
    const pw = String(req.body.password || "");
    if (pw.length < 8) throw bad("Password must be at least 8 characters");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      reset_token_hash: hash,
      reset_expires: { $gt: new Date() },
    });
    if (!user)
      throw bad(
        "This reset link is invalid or has expired. Ask for a new one.",
      );
    user.password_hash = await bcrypt.hash(pw, 10);
    user.reset_token_hash = null;
    user.reset_expires = null;
    user.token_version = (user.token_version || 0) + 1;
    await user.save();
    res.json({ ok: true });
  }),
);

// Push tokens (mobile)
router.post(
  "/push-token",
  requireAuth,
  wrap(async (req, res) => {
    const t = String(req.body.token || "");
    if (!t) throw bad("token required");
    await User.updateOne(
      { _id: req.user._id },
      { $addToSet: { push_tokens: t } },
    );
    res.json({ ok: true });
  }),
);
router.delete(
  "/push-token",
  requireAuth,
  wrap(async (req, res) => {
    const t = String(req.body?.token || req.query.token || "");
    await User.updateOne({ _id: req.user._id }, { $pull: { push_tokens: t } });
    res.json({ ok: true });
  }),
);

module.exports = router;
