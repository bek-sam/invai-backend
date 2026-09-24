/**
 * AI gateway. Every Claude API call goes through here so it is metered per company,
 * validated against its schema, traced (Langfuse) and free of buyer personal data.
 * Patterns: structured single calls, Message Batches for bulk, vision for design text,
 * and a read-only tool-using assistant. See invai-docs/architecture.md section 8.
 */
export {};
