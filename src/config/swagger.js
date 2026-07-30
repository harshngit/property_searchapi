const swaggerJSDoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'PropertySerch.com API',
      version: '1.0.0',
      description:
        'API documentation for PropertySerch.com (Real Estate Transaction Operating System): Authentication & Access, Property Listings, Property Search, and Projects/Units (Builder) modules.',
    },
    servers: [
      {
        url: 'http://localhost:5000/api',
        description: 'Local development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string', example: 'Error message here' },
          },
        },
        RegisterRequest: {
          type: 'object',
          required: ['fullName', 'role'],
          properties: {
            fullName: { type: 'string', example: 'Rahul Sharma' },
            email: { type: 'string', format: 'email', example: 'rahul@example.com' },
            mobile: { type: 'string', example: '9876543210' },
            password: { type: 'string', format: 'password', example: 'Passw0rd!123' },
            role: {
              type: 'string',
              description:
                'All platform roles are listed here for reference. Only `customer` and `broker` can self-register through this endpoint — every other role returns 403 and must be created by an Admin/Super Admin via the invite flow.',
              enum: [
                'customer',
                'broker',
                'agency_admin',
                'builder',
                'internal_sales',
                'admin',
                'super_admin',
              ],
              example: 'customer',
            },
            tenantId: {
              type: 'string',
              nullable: true,
              description: 'Required only when registering under an existing agency/builder tenant.',
              example: null,
            },
          },
        },
        RegisteredUser: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            tenant_id: { type: 'string', format: 'uuid', nullable: true },
            full_name: { type: 'string', example: 'Rahul Sharma' },
            email: { type: 'string', example: 'rahul@example.com' },
            mobile: { type: 'string', example: '9876543210' },
            status: {
              type: 'string',
              enum: ['active', 'pending_approval'],
              example: 'active',
            },
            role: { type: 'string', example: 'customer' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        PropertyMedia: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            property_id: { type: 'string', format: 'uuid' },
            media_type: { type: 'string', enum: ['image', 'video'] },
            url: { type: 'string', example: 'https://cdn.example.com/property1.jpg' },
            display_order: { type: 'integer', example: 0 },
            is_primary: { type: 'boolean', example: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Property: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            tenant_id: { type: 'string', format: 'uuid', nullable: true },
            created_by: { type: 'string', format: 'uuid' },
            broker_id: { type: 'string', format: 'uuid', nullable: true },
            builder_id: { type: 'string', format: 'uuid', nullable: true },
            title: { type: 'string', example: '3BHK Sea View Apartment' },
            description: { type: 'string', nullable: true },
            property_type: {
              type: 'string',
              enum: ['apartment', 'villa', 'independent_house', 'plot', 'commercial', 'farmhouse', 'other'],
            },
            transaction_type: { type: 'string', enum: ['buy', 'sell', 'rent'] },
            price: { type: 'number', example: 8500000 },
            city: { type: 'string', example: 'Mumbai' },
            locality: { type: 'string', nullable: true, example: 'Bandra West' },
            address: { type: 'string', nullable: true },
            latitude: { type: 'number', nullable: true },
            longitude: { type: 'number', nullable: true },
            area_sqft: { type: 'number', nullable: true, example: 1250 },
            bedrooms: { type: 'integer', nullable: true, example: 3 },
            bathrooms: { type: 'integer', nullable: true, example: 2 },
            amenities: { type: 'array', items: { type: 'string' }, example: ['parking', 'gym', 'lift'] },
            status: {
              type: 'string',
              enum: ['draft', 'pending_approval', 'approved', 'rejected', 'inactive'],
            },
            rejection_reason: { type: 'string', nullable: true },
            approved_by: { type: 'string', format: 'uuid', nullable: true },
            approved_at: { type: 'string', format: 'date-time', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
            media: {
              type: 'array',
              items: { $ref: '#/components/schemas/PropertyMedia' },
            },
          },
        },
        PropertyCreateRequest: {
          type: 'object',
          required: ['title', 'propertyType', 'transactionType', 'price', 'city'],
          properties: {
            title: { type: 'string', example: '3BHK Sea View Apartment' },
            description: { type: 'string', example: 'Spacious 3BHK with a private balcony and sea view.' },
            propertyType: {
              type: 'string',
              enum: ['apartment', 'villa', 'independent_house', 'plot', 'commercial', 'farmhouse', 'other'],
              example: 'apartment',
            },
            transactionType: { type: 'string', enum: ['buy', 'sell', 'rent'], example: 'sell' },
            price: { type: 'number', example: 8500000 },
            city: { type: 'string', example: 'Mumbai' },
            locality: { type: 'string', example: 'Bandra West' },
            address: { type: 'string', example: '12 Carter Road' },
            latitude: { type: 'number', example: 19.0596 },
            longitude: { type: 'number', example: 72.8295 },
            areaSqft: { type: 'number', example: 1250 },
            bedrooms: { type: 'integer', example: 3 },
            bathrooms: { type: 'integer', example: 2 },
            amenities: { type: 'array', items: { type: 'string' }, example: ['parking', 'gym', 'lift'] },
            brokerId: { type: 'string', format: 'uuid', nullable: true },
            builderId: { type: 'string', format: 'uuid', nullable: true },
          },
        },
        PropertyUpdateRequest: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            propertyType: {
              type: 'string',
              enum: ['apartment', 'villa', 'independent_house', 'plot', 'commercial', 'farmhouse', 'other'],
            },
            transactionType: { type: 'string', enum: ['buy', 'sell', 'rent'] },
            city: { type: 'string' },
            locality: { type: 'string' },
            address: { type: 'string' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
            areaSqft: { type: 'number' },
            bedrooms: { type: 'integer' },
            bathrooms: { type: 'integer' },
            amenities: { type: 'array', items: { type: 'string' } },
          },
        },
        Project: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            tenant_id: { type: 'string', format: 'uuid', nullable: true },
            builder_id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Skyline Residency' },
            description: { type: 'string', nullable: true },
            city: { type: 'string', example: 'Pune' },
            locality: { type: 'string', nullable: true },
            address: { type: 'string', nullable: true },
            status: {
              type: 'string',
              enum: ['draft', 'upcoming', 'ongoing', 'completed', 'on_hold'],
            },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        ProjectCreateRequest: {
          type: 'object',
          required: ['name', 'city'],
          properties: {
            name: { type: 'string', example: 'Skyline Residency' },
            description: { type: 'string', example: 'A premium 2/3 BHK residential project.' },
            city: { type: 'string', example: 'Pune' },
            locality: { type: 'string', example: 'Baner' },
            address: { type: 'string', example: 'Baner Road' },
            builderId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              description: 'Required when the caller is admin/super_admin; defaults to the caller when they are a builder.',
            },
          },
        },
        ProjectUpdateRequest: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            city: { type: 'string' },
            locality: { type: 'string' },
            address: { type: 'string' },
            status: {
              type: 'string',
              enum: ['draft', 'upcoming', 'ongoing', 'completed', 'on_hold'],
            },
          },
        },
        Unit: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            project_id: { type: 'string', format: 'uuid' },
            unit_number: { type: 'string', example: 'A-1204' },
            floor: { type: 'integer', nullable: true, example: 12 },
            size: { type: 'number', nullable: true, example: 950 },
            price: { type: 'number', example: 6500000 },
            status: { type: 'string', enum: ['available', 'held', 'sold'] },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        UnitCreateRequest: {
          type: 'object',
          required: ['unitNumber', 'price'],
          properties: {
            unitNumber: { type: 'string', example: 'A-1204' },
            floor: { type: 'integer', example: 12 },
            size: { type: 'number', example: 950 },
            price: { type: 'number', example: 6500000 },
          },
        },
        UnitUpdateRequest: {
          type: 'object',
          properties: {
            unitNumber: { type: 'string' },
            floor: { type: 'integer' },
            size: { type: 'number' },
            price: { type: 'number' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ['./src/routes/*.js'],
};

module.exports = swaggerJSDoc(options);