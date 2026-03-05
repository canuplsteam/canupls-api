import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

export async function healthCheck() {
    const { rows } = await pool.query("SELECT NOW() as now");
    return rows[0]?.now;
}
