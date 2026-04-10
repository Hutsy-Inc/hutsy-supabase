-- Copyright 2026 Declan Nnadozie
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     https://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

-- ============================================================
-- app_session: records each time a user opens the app.
-- One row per session; a user may have many sessions.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.app_session (
    session_id      UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL
                        REFERENCES auth.users(id) ON DELETE CASCADE,
    app_opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    device          TEXT        NOT NULL
                        CONSTRAINT app_session_device_values
                        CHECK (device IN ('ios', 'android', 'web', 'other')),

    PRIMARY KEY (session_id)
);

COMMENT ON TABLE public.app_session IS
    'Records each app open event per authenticated user. '
    'One row per session; a user may have many sessions.';

-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE public.app_session ENABLE ROW LEVEL SECURITY;

-- Users may only read their own sessions
CREATE POLICY app_session_select_own
    ON public.app_session
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Users may only insert their own sessions
CREATE POLICY app_session_insert_own
    ON public.app_session
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);
