from sqlalchemy.dialects.postgresql import JSONB

from redash.models.base import Column, db, key_type, primary_key
from redash.models.mixins import BelongsToOrgMixin, TimestampMixin
from redash.models.types import MutableList


class AIConversation(TimestampMixin, BelongsToOrgMixin, db.Model):
    id = primary_key("AIConversation")
    org_id = Column(key_type("Organization"), db.ForeignKey("organizations.id"))
    org = db.relationship("Organization", backref="ai_conversations")
    user_id = Column(key_type("User"), db.ForeignKey("users.id"))
    user = db.relationship("User", backref="ai_conversations")
    query_id = Column(key_type("Query"), db.ForeignKey("queries.id"), nullable=True)
    data_source_id = Column(
        key_type("DataSource"), db.ForeignKey("data_sources.id"), nullable=True
    )
    data_source_ids = Column(MutableList.as_mutable(JSONB), default=[])
    title = Column(db.String(255), default="New Conversation")
    messages = Column(MutableList.as_mutable(JSONB), default=[])
    is_archived = Column(db.Boolean, default=False)

    __tablename__ = "ai_conversations"
    __table_args__ = (
        db.Index("ai_conversations_user_id_org_id", "user_id", "org_id"),
    )

    def to_dict(self):
        return {
            "id": self.id,
            "user_id": self.user_id,
            "query_id": self.query_id,
            "data_source_id": self.data_source_id,
            "data_source_ids": self.data_source_ids or [],
            "title": self.title,
            "messages": self.messages,
            "is_archived": self.is_archived,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
