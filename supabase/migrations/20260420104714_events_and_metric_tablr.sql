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
-- metric_events: historical time-series (source of truth)
-- ============================================================
create table if not exists metric_events (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid        not null,
  entity_type  text        not null,
  metric_name  text        not null,
  value        numeric,
  metadata     jsonb,
  recorded_at  timestamptz not null default now()
);

create index if not exists idx_metric_events_entity_metric_time
  on metric_events (entity_id, metric_name, recorded_at desc);

create index if not exists idx_metric_events_entity_type
  on metric_events (entity_type, recorded_at desc);

-- ============================================================
-- metric_snapshots: latest values per entity (fast reads)
-- ============================================================
create table if not exists metric_snapshots (
  entity_id    uuid        not null,
  entity_type  text        not null,
  data         jsonb       not null default '{}',
  updated_at   timestamptz not null default now(),
  primary key (entity_id, entity_type)
);

create index if not exists idx_metric_snapshots_entity_type
  on metric_snapshots (entity_type);

create index if not exists idx_metric_snapshots_data
  on metric_snapshots using gin(data);

-- ============================================================
-- trigger: keep metric_snapshots in sync on every insert
-- ============================================================
create or replace function sync_metric_snapshot()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into metric_snapshots (entity_id, entity_type, data, updated_at)
  values (
    NEW.entity_id,
    NEW.entity_type,
    jsonb_build_object(NEW.metric_name, NEW.value),
    now()
  )
  on conflict (entity_id, entity_type)
  do update set
    data       = metric_snapshots.data || jsonb_build_object(NEW.metric_name, NEW.value),
    updated_at = now();

  return NEW;
end;
$$;

create trigger trg_sync_metric_snapshot
  after insert on metric_events
  for each row execute function sync_metric_snapshot();

-- ============================================================
-- RLS
-- ============================================================
alter table metric_events    enable row level security;
alter table metric_snapshots enable row level security;

-- Users can only read their own metrics
create policy "users can read own metric_events"
  on metric_events for select
  using (entity_id = auth.uid());

create policy "users can insert own metric_events"
  on metric_events for insert
  with check (entity_id = auth.uid());

create policy "users can read own metric_snapshots"
  on metric_snapshots for select
  using (entity_id = auth.uid());

-- Snapshots are written only by the trigger (security definer), not directly by users
create policy "no direct insert on metric_snapshots"
  on metric_snapshots for insert
  with check (false);

create policy "no direct update on metric_snapshots"
  on metric_snapshots for update
  using (false);

