import { axios } from "@/services/axios";

const AIAssistant = {
  getConversations: () => axios.get("api/ai/conversations"),

  createConversation: (data) => axios.post("api/ai/conversations", data),

  getConversation: (id) => axios.get(`api/ai/conversations/${id}`),

  archiveConversation: (id) => axios.delete(`api/ai/conversations/${id}`),

  sendMessage: (conversationId, data) =>
    axios.post(`api/ai/conversations/${conversationId}/messages`, data),
};

export default AIAssistant;
