import { models } from "../models/index.js";
import Joi from "joi";
import { Op } from "sequelize";
import { sequelize } from "../models/dbClient.js";

const { Order, User, Product, OrderProduct } = models;

const orderSchema = Joi.object({
  userId: Joi.number().required(),
  products: Joi.array()
    .items(
      Joi.object({
        productId: Joi.number().required(),
        quantity: Joi.number().min(1).required(),
      })
    )
    .min(1)
    .required(),
  status: Joi.string().valid("pending", "processing", "shipped", "delivered").default("pending"),
  totalAmount: Joi.number().min(0),
});

// Get all orders with pagination and filtering
export const getAllOrders = async (req, res) => {
  try {
    console.log("Starting getAllOrders");
    console.log("Query parameters:", req.query);
    // pagination dans la requête
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const { status, startDate, endDate, userId } = req.query;

    // filtres dans la requête
    const whereClause = {};
    if (status) whereClause.status = status;
    if (startDate && endDate) {
      whereClause.createdAt = {
        [Op.between]: [new Date(startDate), new Date(endDate)],
      };
    }
    if (userId) whereClause.userId = userId;
    console.log("whereClause", whereClause);

    console.log("executing query...");
    // tri dans la requête
    const { count, rows } = await Order.findAndCountAll({
      where: whereClause,
      limit,
      offset,
      include: [
        {
          model: User,
          attributes: ["id", "username", "email"],
        },
        {
          model: Product,
          through: {
            model: OrderProduct,
            attributes: ["quantity"],
          },
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    console.log("Query executed successfully");
    console.log("Sending response...");

    res.status(200).json({
      success: true,
      message: "Orders fetched successfully",
      data: rows,
      totalPages: Math.ceil(count / limit),
      currentPage: page,
      totalCount: count,
    });
    console.log("Response sent");
  } catch (error) {
    console.error("Error in getAllOrders:", error);
    res.status(500).json({
      success: false,
      message: "Error while fetching orders",
      error: error.message,
    });
  }
};

// Get order by id
export const getOrderById = async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id, {
      include: [
        { model: User, attributes: ["id", "username", "email"] },
        { model: Product, through: { attributes: ["quantity"] } },
      ],
    });
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
        errors: "Order not found",
      });
    }
    res.status(200).json({
      success: true,
      message: "Order found",
      data: order,
    });
  } catch (error) {
    console.error("Error in getOrderById:", error);
    res.status(500).json({
      success: false,
      message: "Error while fetching order",
      error: error.message,
    });
  }
};

// Update order
export const updateOrder = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { error } = orderSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors: error.details[0].message,
      });
    }

    const order = await Order.findByPk(req.params.id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const { userId, products, status } = req.body;

    // Recalculate total amount and update stock
    let totalAmount = 0;
    for (const product of products) {
      const dbProduct = await Product.findByPk(product.productId);
      if (!dbProduct) {
        throw new Error(`Product with id ${product.productId} not found`);
      }

      const oldQuantity = await order.getProducts({
        where: { id: product.productId },
        attributes: ["OrderProduct.quantity"],
      });

      const quantityDiff = product.quantity - (oldQuantity[0]?.OrderProduct.quantity || 0);

      if (dbProduct.stock < quantityDiff) {
        throw new Error(`Insufficient stock for product ${dbProduct.name}`);
      }

      totalAmount += dbProduct.price * product.quantity;

      await Product.increment("stock", {
        by: -quantityDiff,
        where: { id: product.productId },
        transaction: t,
      });
    }

    await order.update({ userId, status, totalAmount }, { transaction: t });

    await order.setProducts([], { transaction: t });
    for (const product of products) {
      await order.addProduct(product.productId, {
        through: { quantity: product.quantity },
        transaction: t,
      });
    }

    await t.commit();

    const updatedOrder = await Order.findByPk(order.id, {
      include: [
        { model: User, attributes: ["id", "username", "email"] },
        { model: Product, through: { attributes: ["quantity"] } },
      ],
    });

    res.status(200).json({
      success: true,
      message: "Order updated successfully",
      data: updatedOrder,
    });
  } catch (error) {
    await t.rollback();
    console.error("Error updating order:", error);
    res.status(500).json({
      success: false,
      message: "Error while updating order",
      error: error.message,
    });
  }
};

// Delete order
export const deleteOrder = async (req, res) => {
  try {
    const orderId = req.params.id;
    const order = await Order.findByPk(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
        errors: "Order not found",
      });
    }
    await order.destroy();
    res.status(200).json({
      success: true,
      message: "Order deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting order:", error);
    res.status(500).json({
      success: false,
      message: "Error while deleting order",
      error: error.message,
    });
  }
};

// Get order statistics
export const getOrderStatistics = async (req, res) => {
  try {
    const totalOrders = await Order.count();
    const totalRevenue = await Order.sum("totalAmount");
    const averageOrderValue = totalRevenue / totalOrders;

    const ordersByStatus = await Order.findAll({
      attributes: ["status", [sequelize.fn("count", sequelize.col("status")), "count"]],
      group: ["status"],
    });

    res.status(200).json({
      success: true,
      message: "Order statistics fetched successfully",
      data: {
        totalOrders,
        totalRevenue,
        averageOrderValue,
        ordersByStatus,
      },
    });
  } catch (error) {
    console.error("Error fetching order statistics:", error);
    res.status(500).json({
      success: false,
      message: "Error while fetching order statistics",
      error: error.message,
    });
  }
};

// Create order

const validateOrderData = async (data) => {
  const { error } = orderSchema.validate(data);
  if (error) {
    throw new Error(error.details[0].message);
  }
};

const calculateTotalAmount = async (products) => {
  let totalAmount = 0;
  for (const product of products) {
    const dbProduct = await Product.findByPk(product.productId);
    if (!dbProduct) {
      throw new Error(`Product with id ${product.productId} not found`);
    }
    if (dbProduct.stock < product.quantity) {
      throw new Error(`Insufficient stock for product ${dbProduct.name}`);
    }
    totalAmount += dbProduct.price * product.quantity;
  }
  return totalAmount;
};

const createOrderInDatabase = async (orderData, t) => {
  return await Order.create(orderData, { transaction: t });
};

const addProductsToOrder = async (newOrder, products, t) => {
  for (const product of products) {
    await newOrder.addProduct(product.productId, {
      through: { quantity: product.quantity },
      transaction: t,
    });
    await Product.decrement("stock", {
      by: product.quantity,
      where: { id: product.productId },
      transaction: t,
    });
  }
};

const getCreatedOrder = async (orderId) => {
  return await Order.findByPk(orderId, {
    include: [
      { model: User, attributes: ["id", "username", "email"] },
      { model: Product, through: { attributes: ["quantity"] } },
    ],
  });
};

export const creatOrder = async (req, res) => {
  const t = await sequelize.transaction();

  try {
    validateOrderData(req.body);

    const { userId, products, status } = req.body;
    const totalAmount = await calculateTotalAmount(products);
    const newOrder = await createOrderInDatabase({ userId, status, totalAmount }, t);
    await addProductsToOrder(newOrder, products, t);
    await t.commit();
    const createdOrder = await getCreatedOrder(newOrder.id);

    res.status(201).json({
      success: true,
      message: "Order created successfully",
      data: createdOrder,
    });
  } catch (error) {
    await t.rollback();
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors: error.errors.map((err) => ({ message: err.message, field: err.path })),
      });
    }
    console.error("Error in createOrder:", error);
    res.status(500).json({
      success: false,
      message: "Error while creating order",
      error: error.message,
    });
  }
};

// export const createOrder = async (req, res) => {
//   const t = await sequelize.transaction();
//   try {
//     const { error } = orderSchema.validate(req.body);
//     if (error) {
//       return res.status(400).json({
//         success: false,
//         message: "Validation error",
//         errors: error.details[0].message,
//       });
//     }

//     const { userId, products, status } = req.body;

//     // Calculate total amount
//     let totalAmount = 0;
//     for (const product of products) {
//       const dbProduct = await Product.findByPk(product.productId);
//       if (!dbProduct) {
//         throw new Error(`Product with id ${product.productId} not found`);
//       }
//       if (dbProduct.stock < product.quantity) {
//         throw new Error(`Insufficient stock for product ${dbProduct.name}`);
//       }
//       totalAmount += dbProduct.price * product.quantity;
//     }

//     const newOrder = await Order.create(
//       {
//         userId,
//         status,
//         totalAmount,
//       },
//       { transaction: t }
//     );

//     for (const product of products) {
//       await newOrder.addProduct(product.productId, {
//         through: { quantity: product.quantity },
//         transaction: t,
//       });
//       await Product.decrement("stock", {
//         by: product.quantity,
//         where: { id: product.productId },
//         transaction: t,
//       });
//     }

//     await t.commit();

//     const createdOrder = await Order.findByPk(newOrder.id, {
//       include: [
//         { model: User, attributes: ["id", "username", "email"] },
//         { model: Product, through: { attributes: ["quantity"] } },
//       ],
//     });

//     res.status(201).json({
//       success: true,
//       message: "Order created successfully",
//       data: createdOrder,
//     });
//   } catch (error) {
//     await t.rollback();
//     if (error.name === "SequelizeUniqueConstraintError") {
//       return res.status(400).json({
//         success: false,
//         message: "Validation error",
//         errors: error.errors.map((err) => ({ message: err.message, field: err.path })),
//       });
//     }
//     console.error("Error in createOrder:", error);
//     res.status(500).json({
//       success: false,
//       message: "Error while creating order",
//       error: error.message,
//     });
//   }
// };
