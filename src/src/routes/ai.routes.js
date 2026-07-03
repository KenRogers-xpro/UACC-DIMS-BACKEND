const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const prisma = require('../lib/prisma');
const { success, serverError } = require('../lib/response');
const { authenticate } = require('../middleware/auth');
const { logAudit, getClientIp } = require('../lib/audit');

const router = express.Router();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'fake-key');

// Format helpers
const formatUgx = (amount) => `UGX ${Number(amount).toLocaleString('en-US')}`;
const getDepartmentName = (role, userDept) => {
  if (role === 'GENERAL_MANAGER') return 'All Departments';
  return userDept ? userDept.replace(/_/g, ' ') : 'Unknown';
};

/**
 * @route   POST /api/ai/chat
 * @desc    Chat with AI agent using real DB context
 * @access  Private
 */
router.post('/chat', authenticate, async (req, res) => {
  try {
    const { messages } = req.body;
    const userMessage = messages[messages.length - 1].content.toLowerCase();
    
    // We'll gather relevant DB context based on keywords to avoid passing entire DB to prompt
    let dbContext = '';

    if (userMessage.includes('procurement') || userMessage.includes('approval') || userMessage.includes('cost') || userMessage.includes('request')) {
      const pendingReqs = await prisma.procurementRequest.findMany({
        where: req.user.role === 'GENERAL_MANAGER' 
          ? { status: 'DEPT_HEAD_APPROVED' } 
          : req.user.role === 'DEPARTMENT_HEAD'
            ? { department: req.user.department, status: 'PENDING' }
            : { requestedById: req.user.id },
        include: { requestedBy: true }
      });
      
      const stats = await prisma.procurementRequest.groupBy({
        by: ['department', 'status'],
        _count: { id: true },
        _sum: { estimatedCost: true }
      });
      
      dbContext += `\n[Procurement Context]
You have ${pendingReqs.length} pending procurement requests needing attention.
Pending Requests Details:
${pendingReqs.map(r => `- ${r.referenceNo}: ${r.itemDescription} (${formatUgx(r.estimatedCost)}) from ${r.requestedBy.name}`).join('\n')}
      `;
    }

    if (userMessage.includes('document') || userMessage.includes('file') || userMessage.includes('upload')) {
      const recentDocs = await prisma.document.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { uploader: true }
      });
      
      const counts = await prisma.document.count();
      
      dbContext += `\n[Document Context]
Total documents in system: ${counts}.
5 Most recent uploads:
${recentDocs.map(d => `- ${d.title} (${d.category}) by ${d.uploader.name} on ${d.createdAt.toISOString().split('T')[0]}`).join('\n')}
      `;
    }

    if (userMessage.includes('log') || userMessage.includes('activity') || userMessage.includes('staff')) {
      const recentLogs = await prisma.activityLog.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { user: true }
      });
      
      dbContext += `\n[Activity Logs Context]
Recent staff activity:
${recentLogs.map(l => `- ${l.user.name} (${l.department}): ${l.activityDescription} (${l.hoursSpent} hrs)`).join('\n')}
      `;
    }

    // Build the system prompt
    const systemPrompt = `
You are the DIMS Executive Assistant for Uganda Air Cargo Corporation (UACC).
You are speaking with ${req.user.name}, who is a ${req.user.role.replace(/_/g, ' ')} in ${getDepartmentName(req.user.role, req.user.department)}.

Your role is to give accurate operational intelligence based ONLY on the provided context.
Today is ${new Date().toDateString()}. UACC is a government-owned aviation corporation at Entebbe International Airport.

Your communication style:
- Concise, data-driven, action-oriented.
- Use bullet points for lists.
- ALWAYS use UGX for currency.
- Do NOT hallucinate data. If the answer isn't in the provided context, say you don't have that specific information right now.

${dbContext}
    `;

    // Format messages for Gemini
    const formattedMessages = messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    }));

    // Start chat
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const chat = model.startChat({
      systemInstruction: systemPrompt,
      history: formattedMessages.slice(0, -1),
    });

    const result = await chat.sendMessage(userMessage);
    const responseText = result.response.text();

    await logAudit({
      userId: req.user.id,
      action: 'LOGIN', // Just logging that they used AI
      module: 'AI Agent',
      description: `Queried AI Agent: "${userMessage.substring(0, 50)}..."`,
      ipAddress: getClientIp(req),
    });

    return success(res, { role: 'assistant', content: responseText });
  } catch (err) {
    console.error('AI Error:', err);
    // Provide a fallback response if API fails
    return success(res, { 
      role: 'assistant', 
      content: "I'm currently unable to connect to the intelligence engine. Please check your system configuration or try again later." 
    });
  }
});

module.exports = router;
