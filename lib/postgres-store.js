class PostgresStore {
  constructor(options) {
    this.connectionString = options.connectionString;
    this.pool = null;
  }

  async connect() {
    const { Pool } = require("pg");
    this.pool = new Pool({
      connectionString: this.connectionString,
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      application_name: "dvs-controller"
    });
    await this.pool.query("SELECT 1");
    await this.migrate();
  }

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS dvs_app_state (
        id smallint PRIMARY KEY CHECK (id = 1),
        payload jsonb NOT NULL,
        revision bigint NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS dvs_televisions (
        id text PRIMARY KEY,
        name text NOT NULL,
        model text NOT NULL DEFAULT '',
        ip inet,
        platform text NOT NULL DEFAULT '',
        app_version text NOT NULL DEFAULT '',
        group_id text NOT NULL DEFAULT 'default',
        status text NOT NULL DEFAULT 'offline',
        last_seen timestamptz,
        created_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS dvs_televisions_ip_idx ON dvs_televisions (ip);
      CREATE INDEX IF NOT EXISTS dvs_televisions_last_seen_idx ON dvs_televisions (last_seen DESC);
    `);
  }

  async load() {
    const result = await this.pool.query("SELECT payload, revision FROM dvs_app_state WHERE id = 1");
    return result.rows[0] || null;
  }

  async save(payload, revision) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO dvs_app_state (id, payload, revision, updated_at)
        VALUES (1, $1::jsonb, $2, now())
        ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, revision = EXCLUDED.revision, updated_at = now()
      `, [JSON.stringify(payload), revision]);
      const ids = [];
      for (const tv of payload.tvs || []) {
        ids.push(tv.id);
        await client.query(`
          INSERT INTO dvs_televisions
            (id, name, model, ip, platform, app_version, group_id, status, last_seen, created_at, updated_at)
          VALUES ($1, $2, $3, NULLIF($4, '')::inet, $5, $6, $7, $8, NULLIF($9, '')::timestamptz, NULLIF($10, '')::timestamptz, now())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name, model = EXCLUDED.model, ip = EXCLUDED.ip,
            platform = EXCLUDED.platform, app_version = EXCLUDED.app_version,
            group_id = EXCLUDED.group_id, status = EXCLUDED.status,
            last_seen = EXCLUDED.last_seen, updated_at = now()
        `, [
          tv.id, tv.name || "TV sem nome", tv.model || "", tv.ip || "", tv.platform || "",
          tv.appVersion || "", tv.groupId || "default", televisionStatus(tv), tv.lastSeen || "", tv.createdAt || ""
        ]);
      }
      if (ids.length) await client.query("DELETE FROM dvs_televisions WHERE NOT (id = ANY($1::text[]))", [ids]);
      else await client.query("DELETE FROM dvs_televisions");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.pool) await this.pool.end();
    this.pool = null;
  }
}

function televisionStatus(tv) {
  if (!tv.lastSeen) return "offline";
  const age = Date.now() - new Date(tv.lastSeen).getTime();
  if (age < 20000) return "online";
  if (age < 90000) return "stale";
  return "offline";
}

module.exports = { PostgresStore };
