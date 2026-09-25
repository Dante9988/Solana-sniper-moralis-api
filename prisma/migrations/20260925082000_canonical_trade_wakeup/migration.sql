-- One empty notification per committed transaction (Postgres coalesces duplicates).
-- The DB remains authoritative; disconnects are repaired by reconciliation sweeps.
CREATE FUNCTION onlypump_notify_canonical_trade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('onlypump_canonical_trade', '');
  RETURN NULL;
END;
$$;
CREATE TRIGGER canonical_trade_wakeup
AFTER INSERT OR UPDATE OR DELETE ON "ChainTrade"
FOR EACH STATEMENT EXECUTE FUNCTION onlypump_notify_canonical_trade();
