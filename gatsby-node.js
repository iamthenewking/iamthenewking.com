const fs = require(`fs`)
const path = require(`path`)
const mkdirp = require(`mkdirp`)
const debug = require(`debug`)
const { createFilePath } = require(`gatsby-source-filesystem`)
const { urlResolve, createContentDigest } = require(`gatsby-core-utils`)
const _ = require('lodash')

const debugBlog = debug(`gatsby-theme-blog-core`)
const withDefaults = require(`./src/utils/default-options`)

// Ensure that content directories exist at site-level
exports.onPreBootstrap = ({ store }, themeOptions) => {
  const { program } = store.getState()
  const { contentPath, assetPath } = withDefaults(themeOptions)

  const dirs = [
    path.join(program.directory, contentPath),
    path.join(program.directory, assetPath),
  ]

  dirs.forEach(dir => {
    debugBlog(`Initializing ${dir} directory`)
    if (!fs.existsSync(dir)) {
      mkdirp.sync(dir)
    }
  })
}

const mdxResolverPassthrough = fieldName => async (
  source,
  args,
  context,
  info,
) => {
  const type = info.schema.getType(`Mdx`)
  const mdxNode = context.nodeModel.getNodeById({
    id: source.parent,
  })
  const resolver = type.getFields()[fieldName].resolve
  const result = await resolver(mdxNode, args, context, {
    fieldName,
  })
  return result
}

exports.createSchemaCustomization = ({ actions, schema }) => {
  const { createTypes } = actions
  createTypes(`interface BlogPost @nodeInterface {
      id: ID!
      title: String!
      body: String!
      slug: String!
      date: Date! @dateformat
      category: [String]!
      keywords: [String]!
      excerpt: String!
      card: File @fileByRelativePath
      published: Boolean!
      editUrl: String!
  }`)

  createTypes(
    schema.buildObjectType({
      name: `MdxBlogPost`,
      fields: {
        id: { type: `ID!` },
        title: {
          type: `String!`,
        },
        slug: {
          type: `String!`,
        },
        card: {
          type: `File`,
        },
        published: {
          type: `Boolean!`,
        },
        editUrl: {
          type: `String!`,
        },
        date: { type: `Date!`, extensions: { dateformat: {} } },
        category: { type: `[String]!` },
        keywords: { type: `[String]!` },
        excerpt: {
          type: `String!`,
          args: {
            pruneLength: {
              type: `Int`,
              defaultValue: 220,
            },
          },
          resolve: mdxResolverPassthrough(`excerpt`),
        },
        body: {
          type: `String!`,
          resolve: mdxResolverPassthrough(`body`),
        },
      },
      interfaces: [`Node`, `BlogPost`],
    }),
  )
}

// Create fields for post slugs and source
// This will change with schema customization with work
exports.onCreateNode = async (
  { node, actions, getNode, createNodeId },
  themeOptions,
) => {
  const { createNode, createParentChildLink } = actions
  const { contentPath, basePath } = withDefaults(themeOptions)

  // Make sure it's an MDX node
  if (node.internal.type !== `Mdx`) {
    return
  }

  // Create source field (according to contentPath)
  const fileNode = getNode(node.parent)
  const source = fileNode.sourceInstanceName

  if (node.internal.type === `Mdx` && source === contentPath) {
    let slug
    if (node.frontmatter.slug) {
      if (path.isAbsolute(node.frontmatter.slug)) {
        // absolute paths take precedence
        slug = node.frontmatter.slug
      } else {
        // otherwise a relative slug gets turned into a sub path
        slug = urlResolve(basePath, node.frontmatter.slug)
      }
    } else {
      // otherwise use the filepath function from gatsby-source-filesystem
      const filePath = createFilePath({
        node: fileNode,
        getNode,
        basePath: contentPath,
      })

      slug = urlResolve(basePath, filePath)
    }
    // normalize use of trailing slash
    slug = slug.replace(/\/*$/, `/`)

    // assign edit url per post
    const editUrl =
      'https://github.com/johnlindquist/johnlindquist.com/edit/master/content/posts' +
      createFilePath({
        node: fileNode,
        getNode,
        basePath: contentPath,
      }).replace(/\/*$/, ``) +
      '.md'
    const fieldData = {
      title: node.frontmatter.title,
      category: node.frontmatter.category || [],
      slug,
      date: node.frontmatter.date,
      keywords: node.frontmatter.keywords || [],
      card: node.frontmatter.card,
      published: node.frontmatter.published,
      editUrl: editUrl,
    }

    const mdxBlogPostId = createNodeId(`${node.id} >>> MdxBlogPost`)
    await createNode({
      ...fieldData,
      // Required fields.
      id: mdxBlogPostId,
      parent: node.id,
      children: [],
      internal: {
        type: `MdxBlogPost`,
        contentDigest: createContentDigest(fieldData),
        content: JSON.stringify(fieldData),
        description: `Mdx implementation of the BlogPost interface`,
      },
    })
    createParentChildLink({ parent: node, child: getNode(mdxBlogPostId) })
  }
}

// These templates are simply data-fetching wrappers that import components
const PostTemplate = require.resolve(`./src/templates/post-query`)
const CategoryTemplate = require.resolve(`./src/templates/category-query`)
const PostsTemplate = require.resolve(`./src/templates/posts-query`)

exports.createPages = async ({ graphql, actions, reporter }, themeOptions) => {
  const { createPage } = actions
  const { basePath } = withDefaults(themeOptions)

  const result = await graphql(`
    {
      allBlogPost(sort: { fields: [date, title], order: DESC }, limit: 1000) {
        edges {
          node {
            id
            slug
            category
          }
        }
      }
      categories: allBlogPost {
        group(field: category) {
          fieldValue
        }
      }
    }
  `)

  if (result.errors) {
    reporter.panic(result.errors)
  }

  // Create Posts and Post pages.
  const { allBlogPost } = result.data
  const posts = allBlogPost.edges
  const categories = result.data.categories.group

  // Create a page for each Category
  categories.forEach(category => {
    createPage({
      // TODO: kebabCase turns JavaScript into /java-script
      path: `/posts/${_.kebabCase(category.fieldValue)}/`,
      component: CategoryTemplate,
      context: {
        category: category.fieldValue,
      },
    })
  })

  // Create a page for each Post
  posts.forEach(({ node: post }, index) => {
    const previous = index === posts.length - 1 ? null : posts[index + 1]
    const next = index === 0 ? null : posts[index - 1]
    const { slug } = post
    createPage({
      path: slug,
      component: PostTemplate,
      context: {
        id: post.id,
        previousId: previous ? previous.node.id : undefined,
        nextId: next ? next.node.id : undefined,
      },
    })
  })

  // Create the Posts page
  // createPage({
  //   path: '/posts',
  //   component: PostsTemplate,
  //   context: {},
  // })

  // Create the Posts page
  createPage({
    path: '/posts',
    component: PostsTemplate,
    context: {},
  })
}
