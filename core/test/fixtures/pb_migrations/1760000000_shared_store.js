/// The part of Palasora's schema Core relies on (users fields, tenants, audit_events), for tests run without Palasora's repo.
/// CI also runs the tests against Palasora's real migrations (PB_MIGRATIONS=palasora/services/pocketbase/pb_migrations).
migrate((app) => {
  const T = (name) => ({ name, type: "text", max: 500 });
  const users = app.findCollectionByNameOrId("users");
  for (const f of [T("tenant_id"), T("handle"), T("display_name"), { name: "account_status", type: "select", values: ["active", "suspended", "deleted"], maxSelect: 1 },
    { name: "profile_kind", type: "select", values: ["human", "editorial_ai", "organization"], maxSelect: 1 }, T("locale")]) users.fields.add(new Field(f));
  users.indexes = [...users.indexes, "CREATE UNIQUE INDEX idx_users_handle ON users (tenant_id, handle) WHERE handle != ''"];
  app.save(users);
  const stamps = [{ name: "created", type: "autodate", onCreate: true }, { name: "updated", type: "autodate", onCreate: true, onUpdate: true }];
  app.save(new Collection({ type: "base", name: "tenants", fields: [T("slug"), T("name"), T("status"), T("canonical_host"), ...stamps] }));
  app.save(new Collection({ type: "base", name: "audit_events", fields: [T("tenant_id"), T("actor_type"), T("actor_id"), T("action"), T("object_type"), T("object_id"),
    { name: "revision", type: "number" }, { name: "metadata_safe", type: "json", maxSize: 20000 }, T("request_id"), ...stamps] }));
});
