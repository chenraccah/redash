"""add_ai_conversations_table

Revision ID: a1b2c3d4e5f6
Revises: e5c7a4e2df4d
Create Date: 2025-01-15 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


# revision identifiers, used by Alembic.
revision = "a1b2c3d4e5f6"
down_revision = "e5c7a4e2df4d"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "ai_conversations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "org_id",
            sa.Integer(),
            sa.ForeignKey("organizations.id"),
            nullable=False,
        ),
        sa.Column(
            "user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column(
            "query_id", sa.Integer(), sa.ForeignKey("queries.id"), nullable=True
        ),
        sa.Column(
            "data_source_id",
            sa.Integer(),
            sa.ForeignKey("data_sources.id"),
            nullable=True,
        ),
        sa.Column(
            "title",
            sa.String(255),
            nullable=False,
            server_default="New Conversation",
        ),
        sa.Column("messages", JSONB, nullable=False, server_default="[]"),
        sa.Column(
            "is_archived", sa.Boolean(), nullable=False, server_default="false"
        ),
        sa.Column(
            "created_at", sa.DateTime(True), server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(True), server_default=sa.func.now()
        ),
    )
    op.create_index(
        "ai_conversations_user_id_org_id",
        "ai_conversations",
        ["user_id", "org_id"],
    )


def downgrade():
    op.drop_table("ai_conversations")
