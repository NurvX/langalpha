"""User-tier skills: per-user skill records + their packaged archives.

Adds the third skill tier. Until now a skill was either platform-authored
(SKILL_REGISTRY + the repo's skills/ directory) or agent-installed (discovered
by scanning a sandbox's .agents/skills, invisible to the server). Neither can
represent "a skill this user brought and owns", which is what plugin install
fans its skills component into.

A row carries the denormalized SKILL.md frontmatter so listings and the agent
build never need to open the archive; the archive itself is the source of
truth for the files, stored content-addressed in object storage (archive_key)
or, when no object storage is configured, inline (archive_blob). Exactly one
of the two is non-null.

plugin_id / plugin_skill_dir are declared here but left unconstrained: the
user_plugins table plugin_id will reference is a sibling change, and a skill
uploaded directly is plugin-less forever. Clearing them in place is the
fork-on-edit affordance — a plugin update then sees the name un-owned and
skips it rather than overwriting a customization.

user_id is deliberately a bare VARCHAR(255) with NO foreign key to users, the
convention every user-scoped table has followed since the initial schema: the
request path resolves user_id from a JWT sub or a relayed X-User-Id header
with no DB read and no get-or-create, so an FK would turn a first write into
an unhandled foreign-key violation.

Revision ID: 026
Revises: 025
"""

from alembic import op


revision = "026"
down_revision = "025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS user_skills (
            user_skill_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id VARCHAR(255) NOT NULL,
            name VARCHAR(64) NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            license TEXT NULL,
            frontmatter JSONB NOT NULL DEFAULT '{}',
            allowed_tools JSONB NOT NULL DEFAULT '[]',
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            confirmed BOOLEAN NOT NULL DEFAULT TRUE,
            plugin_id UUID NULL,
            plugin_skill_dir TEXT NULL,
            content_hash VARCHAR(71) NOT NULL,
            archive_key TEXT NULL,
            archive_blob BYTEA NULL,
            archive_bytes BIGINT NOT NULL DEFAULT 0,
            file_count INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id, name),
            -- The archive lives in object storage or inline, never both and
            -- never neither: a row with no retrievable bytes would advertise a
            -- skill in the manifest that can never be materialized.
            CONSTRAINT user_skills_archive_present CHECK (
                (archive_key IS NULL) <> (archive_blob IS NULL)
            )
        )
    """)
    op.execute("DROP TRIGGER IF EXISTS update_user_skills_updated_at ON user_skills")
    op.execute("""
        CREATE TRIGGER update_user_skills_updated_at
        BEFORE UPDATE ON user_skills
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    """)

    # The agent build reads only the enabled rows, once per turn.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_user_skills_user_enabled
        ON user_skills(user_id)
        WHERE enabled
    """)
    # Plugin uninstall/update scans by owner.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_user_skills_plugin
        ON user_skills(plugin_id)
        WHERE plugin_id IS NOT NULL
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS user_skills CASCADE")
