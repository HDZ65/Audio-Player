/** Migrations versionnées : on ajoute une entrée, on ne modifie jamais une entrée existante. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE facts (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    label TEXT NOT NULL,
    value TEXT,
    numeric_value REAL,
    status TEXT NOT NULL CHECK (status IN ('verifie','estime','manquant')),
    source TEXT NOT NULL,
    as_of TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE fact_history (
    id INTEGER PRIMARY KEY,
    fact_key TEXT NOT NULL,
    value TEXT,
    numeric_value REAL,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    as_of TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    institution TEXT,
    kind TEXT NOT NULL,
    balance REAL NOT NULL,
    as_of TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'saisie manuelle',
    notes TEXT,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE account_snapshots (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    balance REAL NOT NULL,
    as_of TEXT NOT NULL
  );
  CREATE TABLE networth_snapshots (
    date TEXT PRIMARY KEY,
    total REAL NOT NULL,
    liquid REAL NOT NULL,
    invested REAL NOT NULL
  );
  CREATE TABLE holdings (
    id INTEGER PRIMARY KEY,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    ticker TEXT,
    asset_class TEXT NOT NULL DEFAULT 'action',
    sector TEXT,
    quantity REAL,
    value REAL,
    as_of TEXT,
    source TEXT NOT NULL DEFAULT 'saisie manuelle'
  );
  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    date TEXT NOT NULL,
    label TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT NOT NULL DEFAULT 'non classé',
    source TEXT NOT NULL DEFAULT 'saisie manuelle',
    hash TEXT NOT NULL UNIQUE
  );
  CREATE INDEX idx_transactions_date ON transactions(date);
  CREATE TABLE goals (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    target_amount REAL NOT NULL,
    target_date TEXT,
    monthly_contribution REAL,
    status TEXT NOT NULL DEFAULT 'actif',
    assumptions TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE TABLE forecasts (
    id INTEGER PRIMARY KEY,
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    date TEXT NOT NULL,
    scenario TEXT NOT NULL,
    projected REAL NOT NULL
  );
  CREATE TABLE decisions (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    assumptions TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE TABLE simulations (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    input TEXT NOT NULL,
    summary TEXT NOT NULL
  );
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    blocks TEXT NOT NULL DEFAULT '[]',
    steps TEXT NOT NULL DEFAULT '[]',
    engine TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    severity TEXT NOT NULL,
    agent TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    prompt TEXT,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    dismissed_fingerprint TEXT
  );
  CREATE TABLE pending_actions (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    params TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'preparee' CHECK (status IN ('preparee','confirmee','annulee')),
    resolved_at TEXT
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  `,  `
  -- Connexions bancaires en lecture seule (agrégateur agréé) et enrichissement des lignes importées.
  CREATE TABLE bank_connections (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    aspsp_name TEXT NOT NULL,
    aspsp_country TEXT NOT NULL,
    state TEXT NOT NULL UNIQUE,
    session_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('en_attente','active','expiree','erreur')),
    valid_until TEXT,
    created_at TEXT NOT NULL,
    last_sync_at TEXT,
    last_error TEXT
  );
  CREATE TABLE bank_accounts (
    id INTEGER PRIMARY KEY,
    connection_id INTEGER NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
    external_uid TEXT NOT NULL,
    identification_hash TEXT NOT NULL,
    label TEXT NOT NULL,
    iban_masked TEXT,
    account_type TEXT NOT NULL,
    currency TEXT NOT NULL,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL
  );
  ALTER TABLE holdings ADD COLUMN isin TEXT;
  ALTER TABLE holdings ADD COLUMN cost_basis REAL;
  `,
];
