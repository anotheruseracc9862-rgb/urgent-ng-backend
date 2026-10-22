-- Which runners opened an errand, and when. It feeds one number a requester sees on a boosted errand ("opened by 14 runners
-- since boosting"). It holds no more than that: the pair of ids and two times, never shown to anyone, only counted.
CREATE TABLE "errand_views" (
    "errand_id" UUID NOT NULL,
    "viewer_id" UUID NOT NULL,
    "first_viewed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_viewed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "view_count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "errand_views_pkey" PRIMARY KEY ("errand_id", "viewer_id"),
    CONSTRAINT "errand_views_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "errand_views_viewer_id_fkey" FOREIGN KEY ("viewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "errand_views_errand_last_idx" ON "errand_views"("errand_id", "last_viewed_at");
