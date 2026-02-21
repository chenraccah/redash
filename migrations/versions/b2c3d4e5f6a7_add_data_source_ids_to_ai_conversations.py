"""add_data_source_ids_to_ai_conversations

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2025-01-20 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


# revision identifiers, used by Alembic.
revision = "b2c3d4e5f6a7"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "ai_conversations",
        sa.Column("data_source_ids", JSONB, nullable=False, server_default="[]"),
    )
    # Backfill: copy existing data_source_id into the new array column
    op.execute(
        "UPDATE ai_conversations SET data_source_ids = json_build_array(data_source_id) "
        "WHERE data_source_id IS NOT NULL"
    )


def downgrade():
    op.drop_column("ai_conversations", "data_source_ids")
