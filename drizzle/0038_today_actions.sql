CREATE TABLE "today_action_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"date" date NOT NULL,
	"key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"clicked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "today_action_clicks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "today_action_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"date" date NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "today_action_sets_company_id_id_unique" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "today_action_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "today_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"date" date NOT NULL,
	"key" text NOT NULL,
	"rank" integer NOT NULL,
	"detector" text NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"href" text NOT NULL,
	"impact_cents" integer,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "today_actions_company_id_id_unique" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "today_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "today_action_clicks" ADD CONSTRAINT "today_action_clicks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "today_action_clicks" ADD CONSTRAINT "today_action_clicks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "today_action_clicks" ADD CONSTRAINT "today_action_clicks_action_fk" FOREIGN KEY ("company_id","action_id") REFERENCES "public"."today_actions"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "today_action_sets" ADD CONSTRAINT "today_action_sets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "today_actions" ADD CONSTRAINT "today_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "today_actions" ADD CONSTRAINT "today_actions_set_fk" FOREIGN KEY ("company_id","set_id") REFERENCES "public"."today_action_sets"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "today_action_clicks_company_id_action_id_user_id_index" ON "today_action_clicks" USING btree ("company_id","action_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "today_action_sets_company_id_date_index" ON "today_action_sets" USING btree ("company_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "today_actions_company_id_date_key_index" ON "today_actions" USING btree ("company_id","date","key");--> statement-breakpoint
CREATE INDEX "today_actions_company_id_set_id_index" ON "today_actions" USING btree ("company_id","set_id");--> statement-breakpoint
CREATE POLICY "today_action_clicks_tenant" ON "today_action_clicks" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "today_action_sets_tenant" ON "today_action_sets" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "today_actions_tenant" ON "today_actions" AS PERMISSIVE FOR ALL TO "invai_app" USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);