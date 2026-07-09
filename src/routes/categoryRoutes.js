'use strict';

const { Router } = require('express');
const { QueryCommand } = require('@aws-sdk/lib-dynamodb');

const protect = require('../middleware/protect');
const { requireActiveSubscription, checkPlanLimit } = require('../middleware/subscription');
const createCategoryLambda = require('../../lambdas/categories/createCategory');
const deleteCategoryLambda = require('../../lambdas/categories/deleteCategory');
const { dynamoDbClient } = require('../config/awsConfig');

const router = Router();
const CATEGORIES_TABLE = 'categories';

// ─── Helper: adapt Express req/res to Lambda Proxy event ─────────────────────

const invokeLambda = (lambdaHandler) => async (req, res, next) => {
  try {
    const event = {
      body: JSON.stringify({ ...req.body, adminUserId: req.user.userId }),
      pathParameters: req.params,
      queryStringParameters: req.query,
      headers: req.headers,
    };
    const result = await lambdaHandler(event);
    res.status(result.statusCode || 200).json(JSON.parse(result.body));
  } catch (error) {
    next(error);
  }
};

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/categories
 * @desc    List all categories for the authenticated admin
 * @access  Private
 */
router.get('/', protect, async (req, res, next) => {
  try {
    const adminUserId = req.user.userId;

    const result = await dynamoDbClient.send(
      new QueryCommand({
        TableName: CATEGORIES_TABLE,
        IndexName: 'adminUserId-index',
        KeyConditionExpression: 'adminUserId = :aid',
        ExpressionAttributeValues: { ':aid': adminUserId },
      })
    );

    // Sort by createdAt so the order is stable
    const categories = (result.Items || []).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    res.json({ success: true, data: categories });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/categories
 * @desc    Create a new workspace category
 * @access  Private (admin)
 * @body    { name: string }
 */
router.post('/', protect, requireActiveSubscription(), checkPlanLimit('category'), invokeLambda(createCategoryLambda.handler));

/**
 * @route   DELETE /api/categories/:categoryId
 * @desc    Delete a category + cascade-delete all its channels and messages
 * @access  Private (admin, owner)
 */
router.delete('/:categoryId', protect, invokeLambda(deleteCategoryLambda.handler));

module.exports = router;
