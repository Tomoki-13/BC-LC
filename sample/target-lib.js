// inputs/target-lib.js
export function calculateTotal(price, taxRate = 0.1) {
    return price + (price * taxRate);
}

export const greetUser = (name, age) => {
    if (age >= 18) return `Hello ${name}`;
    return `Hi ${name}`;
};