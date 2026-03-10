import datetime
import logging

from flask import request
from flask_restful import abort

from redash import models, settings
from redash.handlers.base import BaseResource
from redash.permissions import require_permission
from redash.services.ai_service import generate_response

logger = logging.getLogger(__name__)


def _check_ai_enabled():
    if not settings.AI_ASSISTANT_ENABLED:
        abort(404, message="AI Assistant is not enabled.")


class AIConversationListResource(BaseResource):
    @require_permission("create_query")
    def get(self):
        """List the current user's AI conversations."""
        _check_ai_enabled()

        conversations = (
            models.AIConversation.query.filter(
                models.AIConversation.user_id == self.current_user.id,
                models.AIConversation.org_id == self.current_org.id,
                models.AIConversation.is_archived.is_(False),
            )
            .order_by(models.AIConversation.updated_at.desc())
            .limit(50)
            .all()
        )
        return [c.to_dict() for c in conversations]

    @require_permission("create_query")
    def post(self):
        """Create a new conversation."""
        _check_ai_enabled()

        req = request.get_json(force=True)
        data_source_ids = req.get("data_source_ids", [])
        # Backwards compat: accept single data_source_id
        if not data_source_ids and req.get("data_source_id"):
            data_source_ids = [req["data_source_id"]]

        conversation = models.AIConversation(
            org_id=self.current_org.id,
            user_id=self.current_user.id,
            data_source_id=req.get("data_source_id") or (data_source_ids[0] if data_source_ids else None),
            data_source_ids=data_source_ids,
            query_id=req.get("query_id"),
            title=req.get("title", "New Conversation"),
            messages=[],
        )
        models.db.session.add(conversation)
        models.db.session.commit()

        return conversation.to_dict()


class AIConversationResource(BaseResource):
    @require_permission("create_query")
    def get(self, conversation_id):
        _check_ai_enabled()

        conversation = models.AIConversation.query.filter_by(
            id=conversation_id,
            user_id=self.current_user.id,
            org_id=self.current_org.id,
        ).first()
        if not conversation:
            abort(404)
        return conversation.to_dict()

    @require_permission("create_query")
    def delete(self, conversation_id):
        """Archive a conversation."""
        _check_ai_enabled()

        conversation = models.AIConversation.query.filter_by(
            id=conversation_id,
            user_id=self.current_user.id,
            org_id=self.current_org.id,
        ).first()
        if not conversation:
            abort(404)

        conversation.is_archived = True
        models.db.session.commit()
        return {"success": True}


class AIConversationMessageResource(BaseResource):
    @require_permission("create_query")
    def post(self, conversation_id):
        """Send a user message and get an AI response."""
        _check_ai_enabled()

        if not settings.AI_LLM_BASE_URL:
            abort(400, message="LLM endpoint is not configured. Set REDASH_AI_LLM_BASE_URL.")

        conversation = models.AIConversation.query.filter_by(
            id=conversation_id,
            user_id=self.current_user.id,
            org_id=self.current_org.id,
        ).first()
        if not conversation:
            abort(404)

        req = request.get_json(force=True)
        user_message = (req.get("message") or "").strip()
        if not user_message:
            abort(400, message="Message cannot be empty.")

        error_context = req.get("error_context")
        data_source_ids = req.get("data_source_ids") or conversation.data_source_ids or []
        data_source_id = req.get("data_source_id") or conversation.data_source_id

        # Backwards compat: if no data_source_ids but single id exists
        if not data_source_ids and data_source_id:
            data_source_ids = [data_source_id]

        # Update stored values if changed
        if data_source_ids != (conversation.data_source_ids or []):
            conversation.data_source_ids = data_source_ids
        if data_source_id and data_source_id != conversation.data_source_id:
            conversation.data_source_id = data_source_id

        # Fetch schema from all data sources
        schema = {}
        db_type = "sql"
        for ds_id in data_source_ids:
            try:
                ds = models.DataSource.get_by_id(ds_id)
                ds_db_type = ds.query_runner.syntax or "sql"
                try:
                    ds_schema = ds.get_schema() or []
                except Exception as e:
                    logger.warning(
                        "Could not fetch schema for data source %s: %s",
                        ds_id,
                        e,
                    )
                    ds_schema = []

                # Also try the cached schema if live fetch failed
                if not ds_schema:
                    ds_schema = ds.get_cached_schema() or []

                schema[ds_id] = {
                    "name": ds.name,
                    "description": ds.description or "",
                    "schema": ds_schema,
                    "db_type": ds_db_type,
                }
                db_type = ds_db_type  # use last as default
            except Exception as e:
                logger.warning(
                    "Could not load data source %s: %s",
                    ds_id,
                    e,
                )

        # If only one data source, extract db_type but keep dict format
        # to preserve name and description for the LLM prompt
        if len(schema) == 1:
            only = list(schema.values())[0]
            db_type = only["db_type"]

        # Append user message
        user_msg = {
            "role": "user",
            "content": user_message,
            "timestamp": datetime.datetime.utcnow().isoformat(),
        }
        if error_context:
            user_msg["error_context"] = error_context

        conversation.messages = list(conversation.messages) + [user_msg]

        # Generate AI response
        try:
            ai_result = generate_response(
                user_message=user_message,
                conversation_messages=conversation.messages[:-1],
                schema=schema,
                db_type=db_type,
                error_context=error_context,
            )
        except Exception as e:
            logger.exception("AI generation failed")
            abort(500, message=f"AI generation failed: {str(e)}")

        # Build and store assistant message
        assistant_msg = {
            "role": "assistant",
            "content": ai_result["content"],
            "timestamp": datetime.datetime.utcnow().isoformat(),
        }
        if ai_result.get("sql"):
            assistant_msg["sql"] = ai_result["sql"]
        if ai_result.get("visualization"):
            assistant_msg["visualization"] = ai_result["visualization"]
        if ai_result.get("target_data_source"):
            assistant_msg["target_data_source"] = ai_result["target_data_source"]
        if ai_result.get("is_clarification"):
            assistant_msg["is_clarification"] = True

        conversation.messages = list(conversation.messages) + [assistant_msg]

        # Auto-title from first user message
        if (
            conversation.title == "New Conversation"
            and len(conversation.messages) <= 2
        ):
            conversation.title = user_message[:100]

        models.db.session.commit()

        self.record_event(
            {
                "action": "ai_chat",
                "object_id": str(conversation.id),
                "object_type": "ai_conversation",
            }
        )

        return {
            "conversation": conversation.to_dict(),
            "response": assistant_msg,
        }
