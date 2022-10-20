import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { GraphQLEnumType, GraphQLInputField, GraphQLInputObjectType, GraphQLInputType, GraphQLNamedType, parse } from 'graphql';
import { loadSchema } from '@graphql-tools/load';
import { GraphQLFileLoader } from '@graphql-tools/graphql-file-loader';
const fs = require('fs');

function getAllFiles(path: string) {
    // Read all files in the current directory and sub directory
    const files = fs.readdirSync(path, { withFileTypes: true })
    .reduce((files: any, file: any) => {
        return files.concat(file.isDirectory() ? getAllFiles(path + file.name + '/') : path + file.name);
    }, []);
    return files;
}

function getQueries(files: string[]) {
    const queries = files.filter((file: string) => file.endsWith('.ts'))
    .map((file: string) => {
        const content = fs.readFileSync(file, 'utf8');            
        const regex = /gql`([\s\S]*?)`/g;
        const matches = content.match(regex);
        if (matches) {
            return matches.map((match: string) => {
                return match
                .replace('gql`', '')
                .replace('`', '')
                .replace(/\$\{[a-zA-Z_]*?\}/g, '')
                .replace(/"\$\{[a-zA-Z_.]*?\}"/g, (match: string) => {
                    let value = match.split('.')?.pop()?.replace('{', '').replace('}', '').replace('"', '') ?? '';
                    return `"${value}"`;
                })
                .replace(/\$\{[a-zA-Z_.]*?\}/g, (match: string) => {
                    const value = match.split('.')?.pop()?.replace('{', '').replace('}', '') ?? '';
                    return `${value}`;
                });
            });
        }
        return [];
    })
    .flat();
    return queries;
}

function createFiles(queries: string[]) {
    // Create an object with all queries in an array and all fragment in an array
    const queriesObject = queries.reduce((acc: any, query: string) => {
        if (query.trim().startsWith('fragment')) {
            acc.fragments.push(query);
        } else {
            acc.queries.push(query);
        }
        return acc;
    }, { queries: [], fragments: [] });
    // Write a file for queries and one for fragments
    fs.writeFileSync('queries.gql', queriesObject.queries.join('\n'));
    fs.writeFileSync('fragments.gql', queriesObject.fragments.join('\n'));
    
    return {
        queriesPath: 'queries.gql',
        fragmentsPath: 'fragments.gql'
    }
}

async function getInputTypes(schemaPath: string): Promise<GraphQLInputObjectType[]> {
    const schema = await loadSchema(schemaPath, {
        loaders: [
            new GraphQLFileLoader()
        ]
    });

    const inputTypes = Object.keys(schema.getTypeMap())
    .filter((type: string) => type.endsWith('Input'))
    .map((type: string) => {
        return schema.getType(type);
    });

    return inputTypes as GraphQLInputObjectType[];
}

async function getEnumFromSchema(schemaPath: string): Promise<GraphQLEnumType[]> {
    const schema = await loadSchema(schemaPath, {
        loaders: [
            new GraphQLFileLoader()
        ]
    });

    const enumTypes = Object.keys(schema.getTypeMap())
    .filter((type: string) => type.endsWith('Enum'))
    .map((type: string) => {
        return schema.getType(type);
    });
    return enumTypes as GraphQLEnumType[];
}

function makeInputType(type: string, variable: string, inputTypes: GraphQLInputObjectType[], enumTypes: GraphQLEnumType[]): any {
    type = type.replace('!', '');

    // Edge case
    if (type === 'ContractLinkType') {
        return 'BASIC';
    }

    // Check if it's an array
    if (type.endsWith(']') || type.startsWith('[')) {
        return [];
    }

    // Check if it's an enum
    if (type.includes('Enum')) {
        // Get this enum from the schema and get a valid value
        const enumType = enumTypes.find((enumType: GraphQLEnumType) => enumType.name === type);
        if (enumType) {
            return enumType.getValues()[0].value;
        }

        return;
    };

    // Check type
    switch (type) {
        case 'String':
        case 'ID':
        case 'JSON':
            return 'test';
        case 'Int':
        case 'Float':
            return 1;
        case 'Boolean':
            return true;
        default:
            if (inputTypes.map(t => t.name).includes(type)) {
                // Create an object with all fields of the input type
                const inputType = inputTypes.find((t: any) => t.name === type);
                if (!inputType) return;
                const fieldsMap = inputType.getFields();

                const fields = Object.keys(fieldsMap).map((fieldName: string) => {
                    const field = fieldsMap[fieldName];
                    const fieldType = field.type.toString().replace('!', '').trim();
                    switch (fieldType) {
                        case 'String':
                        case 'ID':
                        case 'JSON':
                            return { [fieldName]: 'test' };
                        case 'Int':
                        case 'Float':
                            return { [fieldName]: 1 };
                        case 'Boolean':
                            return { [fieldName]: true };
                        default:
                            // Recursive function to create an object with all fields of the input type
                            return { [fieldName]: makeInputType(fieldType, variable, inputTypes, enumTypes) };
                    }
                });

                return fields.reduce((acc: any, field: any) => {
                    return { ...acc, ...field };
                }
                , {});
            } 

        return;
    }
}

async function calculateComplexity(schemaPath: string, queriesPath: string, fragmentsPath: string) {
    const schema = await loadSchema(schemaPath, { loaders: [new GraphQLFileLoader()] });
    const queries = fs.readFileSync(queriesPath, 'utf8');
    const fragments = fs.readFileSync(fragmentsPath, 'utf8');
    // Parse queries by mutation or query (get all string between all matches (including match))
    const regex = /query|mutation/g;
    const matches = queries.match(regex);
    if (matches) {
        const queriesArray = queries.split(regex);
        // Remove first element (empty string)
        queriesArray.shift();
        // Remove last element (empty string)
        queriesArray.pop();
        // Create an array of queries with the match (query or mutation) at the beginning
        const queriesWithMatch = queriesArray.map((query: string, index: number) => {
            return `${matches[index]}${query}`;
        });
        
        const inputTypes = await getInputTypes(schemaPath);
        const enumTypes = await getEnumFromSchema(schemaPath);
        
        // Calculate complexity for each query
        let countErrors = 0;
        let countSuccess = 0;
        // This map return promises, so wait them all
        const complexityArray: {
            complexity: number;
            complexityWithFragments: number;
            error?: string;
        }[] = await Promise.all(queriesWithMatch.map(async (query: string) => {
            // Generate query variables based on the query
            // Get variables in query
            const regex = /\$[a-zA-Z-_]*?:/g;
            const matches = query.match(regex);
            // Create an object with all variables
            const variables = matches ? matches.reduce((acc: any, match: string) => {
                // Get type of variable (string, Int, Boolean, etc.)
                let type = query.split(match)[1].split('!')[0].trim();
                const variable = match.replace('$', '').replace(':', '');
                // Create variable based on the type
                const value = makeInputType(type, variable, inputTypes, enumTypes);
                return value ? { ...acc, [variable]: value } : acc;
            }, {}) : {};
            
            try {
                const complexity = getComplexity({
                    estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
                    schema,
                    query: parse(query),
                    variables: variables,
                });

                const complexityWithFragments = getComplexity({
                    estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
                    schema,
                    query: parse(`${query}\n${fragments}`),
                    variables: variables,
                });
                countSuccess++;
                return {
                    complexity,
                    complexityWithFragments,
                };
            } catch (e: any) {
                // Log error in case complexity cannot be calculated (invalid query, misconfiguration, etc.)
                console.error('Could not calculate complexity', e.message, query.split('{')[0].split('(')[0].trim());
                countErrors++;
                return {
                    complexity: 0,
                    complexityWithFragments: 0,
                    error: e.message
                };
            }
        }));
        
        // Create an object with the query and the complexity
        const complexityObject = queriesWithMatch.map((query: string, index: number) => {
            return {
                queryName: query.split('{')[0].split('(')[0].trim().split(' ')[1],
                type: query.split('{')[0].split('(')[0].trim().split(' ')[0],
                complexity: complexityArray[index].complexity,
                complexityWithFragments: complexityArray[index].complexityWithFragments,
                error: complexityArray[index].error,
            }
        });
        
        
        // Sort by complexity
        complexityObject.sort((a: any, b: any) => b.complexityWithFragments - a.complexityWithFragments);
        const maxComplexity = complexityObject[0].complexityWithFragments;
        console.log(`Success: ${countSuccess}, Errors: ${countErrors}, Max complexity: ${maxComplexity}`);

        // Write a file with all queries and their complexity
        fs.writeFileSync('complexity.json', JSON.stringify(complexityObject, null, 2));
    }
}

const main = async () => {
    const files = getAllFiles('../../app/src/queries/');
    const queries = getQueries(files);

    const paths = createFiles(queries);

    await calculateComplexity('./schema.gql', paths.queriesPath, paths.fragmentsPath);
};

main();
