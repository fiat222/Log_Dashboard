# ADR-0004: Use PostgreSQL for Platform Metadata

## Status

Accepted

## Context

The platform needs a reliable relational store for mutable application state. This state is different from log/event data because it changes over time and requires constraints, transactions, and relationships.

## Decision

Use PostgreSQL for platform metadata.

PostgreSQL stores:

- Users.
- Roles.
- Member management state.
- Service identity mappings.
- Service ownership.
- Dashboard preferences.
- Module visibility/configuration.
- Alert rule definitions.
- Agent registration state.

## Consequences

Benefits:

- Strong fit for relational metadata.
- Supports constraints and transactions.
- Keeps ClickHouse focused on logs/events.
- Makes future admin/dashboard customization easier.

Trade-offs:

- Adds another database service to the central stack.
- Requires migration strategy.
- Requires backup documentation.

## Notes

The central Docker Compose stack should support local PostgreSQL by default, with future ability to point to external PostgreSQL through environment variables.

