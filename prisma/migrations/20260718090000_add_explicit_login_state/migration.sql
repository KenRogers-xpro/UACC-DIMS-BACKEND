-- Explicit login/logout state, decoupled from lastSeenAt — JWT auth has no
-- server-side session to end, so "online" was purely a function of request
-- recency and never actually went false on logout.
ALTER TABLE "users" ADD COLUMN "isLoggedIn" BOOLEAN NOT NULL DEFAULT false;
