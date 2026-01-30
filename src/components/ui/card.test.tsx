import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './card';

describe('Card Components', () => {
  describe('Card', () => {
    it('renders children', () => {
      render(<Card>Card content</Card>);
      expect(screen.getByText('Card content')).toBeInTheDocument();
    });

    it('applies custom className', () => {
      render(<Card className="custom-card" data-testid="card">Content</Card>);
      expect(screen.getByTestId('card')).toHaveClass('custom-card');
    });

    it('has base styling', () => {
      render(<Card data-testid="card">Content</Card>);
      const card = screen.getByTestId('card');
      expect(card).toHaveClass('rounded-lg');
      expect(card).toHaveClass('border');
    });
  });

  describe('CardHeader', () => {
    it('renders children', () => {
      render(
        <Card>
          <CardHeader>Header content</CardHeader>
        </Card>
      );
      expect(screen.getByText('Header content')).toBeInTheDocument();
    });

    it('has correct padding', () => {
      render(
        <Card>
          <CardHeader data-testid="header">Header</CardHeader>
        </Card>
      );
      expect(screen.getByTestId('header')).toHaveClass('p-6');
    });
  });

  describe('CardTitle', () => {
    it('renders as h3', () => {
      render(
        <Card>
          <CardHeader>
            <CardTitle>Title</CardTitle>
          </CardHeader>
        </Card>
      );
      expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Title');
    });

    it('has appropriate styling', () => {
      render(
        <Card>
          <CardHeader>
            <CardTitle data-testid="title">Title</CardTitle>
          </CardHeader>
        </Card>
      );
      expect(screen.getByTestId('title')).toHaveClass('font-semibold');
    });
  });

  describe('CardDescription', () => {
    it('renders description text', () => {
      render(
        <Card>
          <CardHeader>
            <CardDescription>Description text</CardDescription>
          </CardHeader>
        </Card>
      );
      expect(screen.getByText('Description text')).toBeInTheDocument();
    });

    it('has muted styling', () => {
      render(
        <Card>
          <CardHeader>
            <CardDescription data-testid="desc">Description</CardDescription>
          </CardHeader>
        </Card>
      );
      expect(screen.getByTestId('desc')).toHaveClass('text-muted-foreground');
    });
  });

  describe('CardContent', () => {
    it('renders content', () => {
      render(
        <Card>
          <CardContent>Content here</CardContent>
        </Card>
      );
      expect(screen.getByText('Content here')).toBeInTheDocument();
    });
  });

  describe('CardFooter', () => {
    it('renders footer content', () => {
      render(
        <Card>
          <CardFooter>Footer content</CardFooter>
        </Card>
      );
      expect(screen.getByText('Footer content')).toBeInTheDocument();
    });

    it('has flex layout', () => {
      render(
        <Card>
          <CardFooter data-testid="footer">Footer</CardFooter>
        </Card>
      );
      expect(screen.getByTestId('footer')).toHaveClass('flex');
    });
  });

  describe('Full Card composition', () => {
    it('renders complete card structure', () => {
      render(
        <Card>
          <CardHeader>
            <CardTitle>Game Title</CardTitle>
            <CardDescription>Game description</CardDescription>
          </CardHeader>
          <CardContent>
            <p>Game details</p>
          </CardContent>
          <CardFooter>
            <button>Play</button>
          </CardFooter>
        </Card>
      );

      expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Game Title');
      expect(screen.getByText('Game description')).toBeInTheDocument();
      expect(screen.getByText('Game details')).toBeInTheDocument();
      expect(screen.getByRole('button')).toHaveTextContent('Play');
    });
  });
});

