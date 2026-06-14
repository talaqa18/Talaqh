# Migrations

Ordered SQL schema, applied in filename order. **0001–0005 are the schema
foundation** (enums, content tables, user tables + trust boundary, gamification,
indexes). **0006–0010 are reserved** for RLS policies, `SECURITY DEFINER` RPCs,
Storage policies, and content-resolution helpers owned by other agents.

See the table and integrity explanation in [`../README.md`](../README.md) and
the product constants in [`../../DECISIONS.md`](../../DECISIONS.md). Do not
renumber existing files.
