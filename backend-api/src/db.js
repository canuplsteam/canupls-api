import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined
});

export async function healthCheck() {
    const { rows } = await pool.query("SELECT NOW() as now");
    return rows[0]?.now;
}
