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
-- loan_data: stores personal and financial data submitted by
-- a user as part of a loan application. One row per user.
-- SSNs are intentionally excluded from this table.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.loan_data (
    -- Primary key is the auth user — one row per user (upsert pattern)
    user_id             UUID        NOT NULL
                            REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Personal Information
    first_name          TEXT        NOT NULL,
    last_name           TEXT        NOT NULL,
    email               TEXT        NOT NULL,
    date_of_birth       DATE        NOT NULL,           -- stored as yyyy-MM-dd
    primary_phone       TEXT,                           -- 10 raw digits, no formatting
    address1            TEXT,
    address2            TEXT,                           -- nullable
    city                TEXT,
    state               CHAR(2)
                            CONSTRAINT loan_data_state_format
                            CHECK (state ~ '^[A-Z]{2}$'),
    zip                 TEXT,                           -- 5 or 9 digit

    -- Financial Information
    employment_status       TEXT
                                CONSTRAINT loan_data_employment_status_values
                                CHECK (employment_status IS NULL OR employment_status IN (
                                    'employed', 'self_employed', 'retired',
                                    'not_employed', 'part_time'
                                )),
    employment_pay_frequency TEXT
                                CONSTRAINT loan_data_pay_frequency_values
                                CHECK (employment_pay_frequency IS NULL OR employment_pay_frequency IN (
                                    'weekly', 'biweekly', 'semi_monthly', 'monthly'
                                )),
    annual_income           INTEGER
                                CONSTRAINT loan_data_annual_income_positive
                                CHECK (annual_income IS NULL OR annual_income > 0),

    -- Credit & Housing
    provided_credit_rating  TEXT
                                CONSTRAINT loan_data_credit_rating_values
                                CHECK (provided_credit_rating IS NULL OR provided_credit_rating IN (
                                    'excellent', 'good', 'fair', 'poor', 'limited'
                                )),
    property_status         TEXT
                                CONSTRAINT loan_data_property_status_values
                                CHECK (property_status IS NULL OR property_status IN (
                                    'rent', 'own', 'own_with_mortgage', 'other'
                                )),

    -- Timestamps
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id)
);

COMMENT ON TABLE public.loan_data IS
    'Stores personal and financial data submitted by a user during a loan application. '
    'One row per authenticated user. SSNs are never stored here.';

-- ============================================================
-- Trigger: keep updated_at current on every row update
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_loan_data_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_loan_data_updated_at
    BEFORE UPDATE ON public.loan_data
    FOR EACH ROW
    EXECUTE FUNCTION public.set_loan_data_updated_at();

-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE public.loan_data ENABLE ROW LEVEL SECURITY;

-- Authenticated users may only read their own row
CREATE POLICY loan_data_select_own
    ON public.loan_data
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Authenticated users may only insert/update their own row
CREATE POLICY loan_data_write_own
    ON public.loan_data
    FOR ALL
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
