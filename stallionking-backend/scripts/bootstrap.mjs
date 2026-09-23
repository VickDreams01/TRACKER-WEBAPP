// Run only on a trusted administrator machine; no secrets are written to disk.
const {
  SUPABASE_URL: url,
  SUPABASE_SERVICE_ROLE_KEY: key,
  STAFF_ID: staffId,
  STAFF_NAME: name,
  STAFF_PASSWORD: password,
} = process.env;
if (
  !url ||
  !key ||
  !name ||
  !/^[A-Z0-9-]{3,32}$/i.test(staffId || "") ||
  !password ||
  password.length < 12
)
  throw new Error(
    "Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STAFF_ID, STAFF_NAME and STAFF_PASSWORD (12+ characters).",
  );
const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};
async function request(path, options = {}) {
  const response = await fetch(url.replace(/\/$/, "") + path, {
    ...options,
    headers,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      data?.message ||
        data?.msg ||
        data?.error_description ||
        `Request failed (${response.status})`,
    );
  return data;
}
const existing = await request("/rest/v1/profiles?select=user_id&limit=1");
if (existing.length)
  throw new Error("Staff already exist. Use Admin Users in the application.");
const user = await request("/auth/v1/admin/users", {
  method: "POST",
  body: JSON.stringify({
    email: staffId.toLowerCase() + "@staff.stallionking.internal",
    password,
    email_confirm: true,
  }),
});
try {
  await request("/rest/v1/rpc/provision_staff", {
    method: "POST",
    body: JSON.stringify({
      auth_user_id: user.id,
      staff_id_value: staffId,
      display_name: name,
      staff_role_value: "superadmin",
    }),
  });
} catch (error) {
  await request("/auth/v1/admin/users/" + user.id, { method: "DELETE" });
  throw error;
}
console.log(
  `Created superadmin ${staffId.toUpperCase()}. Sign in through the tracker.`,
);
